'use strict'

const importer = require('ipfs-unixfs-importer')
const normaliseAddInput = require('ipfs-core-utils/src/files/normalise-input')
const { parseChunkerString } = require('./utils')
const pipe = require('it-pipe')
const { withTimeoutOption } = require('../../utils')

/**
 * @typedef {Uint8Array | Blob | String | Iterable<Uint8Array|Number> | AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>} FileContent
 *
 * @typedef {object} FileObject
 *  - If no path is specified, then the item will be added to the root level and will be given a name according to it's CID.
 *  - If no content is passed, then the item is treated as an empty directory.
 *  - One of path or content must be passed.
 * @property {string} [path] - The path you want to the file to be accessible at from the root CID _after_ it has been added
 * @property {FileContent} [content] - The contents of the file
 * @property {number | string} [mode] - File mode to store the entry with (see https://en.wikipedia.org/wiki/File_system_permissions#Numeric_notation)
 * @property {UnixTime} [mtime] - The modification time of the entry
 *
 * @typedef {FileContent | FileObject} Source
 * @typedef {Iterable<Source> | AsyncIterable<Source> | ReadableStream<Source>} FileStream
 *
 * @typedef {Date | UnixTimeObj | [number, number]} UnixTime - As an array of numbers, it must have two elements, as per the output of [`process.hrtime()`](https://nodejs.org/dist/latest/docs/api/process.html#process_process_hrtime_time).
 *
 * @typedef {object} UnixTimeObj
 * @property {number} secs - the number of seconds since (positive) or before (negative) the Unix Epoch began
 * @property {number} [nsecs] - the number of nanoseconds since the last full second.
 *
 * @typedef {object} UnixFSEntry
 * @property {string} path
 * @property {import('cids')} cid
 * @property {number} mode
 * @property {UnixTimeObj} mtime
 * @property {number} size
 */

module.exports = ({ block, gcLock, preload, pin, options: constructorOptions }) => {
  const isShardingEnabled = constructorOptions.EXPERIMENTAL && constructorOptions.EXPERIMENTAL.sharding

  /**
   * Import multiple files and data into IPFS.
   *
   * @param {FileStream} source
   *
   * @param {object} [options]
   * @param {string} [options.chunker] - chunking algorithm used to build ipfs DAGs (default: `'size-262144'`)
   * @param {Number} [options.cidVersion] - the CID version to use when storing the data (default: `0`)
   * @param {boolean} [options.enableShardingExperiment] - allows to create directories with an unlimited number of entries currently size of unixfs directories is limited by the maximum block size. Note that this is an experimental feature (default: `false`)
   * @param {String} [options.hashAlg] - multihash hashing algorithm to use (default: `'sha2-256'`)
   * @param {boolean} [options.onlyHash] - If true, will not add blocks to the blockstore (default: `false`)
   * @param {boolean} [options.pin] - pin this object when adding (default: `true`)
   * @param {function} [options.progress] - a function that will be called with the byte length of chunks as a file is added to ipfs (default: `undefined`)
   * @param {boolean} [options.rawLeaves] - if true, DAG leaves will contain raw file data and not be wrapped in a protobuf (default: `false`)
   * @param {Number} [options.shardSplitThreshold] - Directories with more than this number of files will be created as HAMT-sharded directories (default: `1000`)
   * @param {boolean} [options.trickle] - if true will use the [trickle DAG](https://godoc.org/github.com/ipsn/go-ipfs/gxlibs/github.com/ipfs/go-unixfs/importer/trickle) format for DAG generation (default: `false`)
   * @param {boolean} [options.wrapWithDirectory] - Adds a wrapping node around the content (default: `false`)
   * @param {Number} [options.timeout] - A timeout in ms (default: `undefined`)
   * @param {AbortSignal} [options.signal] - Can be used to cancel any long running requests started as a result of this call (default: `undefined`)

   * @returns {AsyncIterable<UnixFSEntry>}
   */
  async function * addAll (source, options) {
    options = options || {}

    const opts = {
      shardSplitThreshold: isShardingEnabled ? 1000 : Infinity,
      ...options,
      strategy: 'balanced',
      ...parseChunkerString(options.chunker)
    }

    // CID v0 is for multihashes encoded with sha2-256
    if (opts.hashAlg && opts.hashAlg !== 'sha2-256' && opts.cidVersion !== 1) {
      opts.cidVersion = 1
    }

    if (opts.trickle) {
      opts.strategy = 'trickle'
    }

    delete opts.trickle

    if (opts.progress) {
      let total = 0
      const prog = opts.progress

      opts.progress = (bytes) => {
        total += bytes
        prog(total)
      }
    }

    const iterator = pipe(
      normaliseAddInput(source),
      source => importer(source, block, {
        ...opts,
        pin: false
      }),
      transformFile(opts),
      preloadFile(preload, opts),
      pinFile(pin, opts)
    )

    const releaseLock = await gcLock.readLock()

    try {
      yield * iterator
    } finally {
      releaseLock()
    }
  }

  return withTimeoutOption(addAll)
}

function transformFile (opts) {
  return async function * (source) {
    for await (const file of source) {
      let cid = file.cid

      if (opts.cidVersion === 1) {
        cid = cid.toV1()
      }

      let path = file.path ? file.path : cid.toString()

      if (opts.wrapWithDirectory && !file.path) {
        path = ''
      }

      yield {
        path,
        cid,
        size: file.size,
        mode: file.unixfs && file.unixfs.mode,
        mtime: file.unixfs && file.unixfs.mtime
      }
    }
  }
}

function preloadFile (preload, opts) {
  return async function * (source) {
    for await (const file of source) {
      const isRootFile = !file.path || opts.wrapWithDirectory
        ? file.path === ''
        : !file.path.includes('/')

      const shouldPreload = isRootFile && !opts.onlyHash && opts.preload !== false

      if (shouldPreload) {
        preload(file.cid)
      }

      yield file
    }
  }
}

function pinFile (pin, opts) {
  return async function * (source) {
    for await (const file of source) {
      // Pin a file if it is the root dir of a recursive add or the single file
      // of a direct add.
      const isRootDir = !file.path.includes('/')
      const shouldPin = (opts.pin == null ? true : opts.pin) && isRootDir && !opts.onlyHash

      if (shouldPin) {
        // Note: addAsyncIterator() has already taken a GC lock, so tell
        // pin.add() not to take a (second) GC lock
        await pin.add(file.cid, {
          preload: false,
          lock: false
        })
      }

      yield file
    }
  }
}
