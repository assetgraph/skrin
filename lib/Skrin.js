var _ = require('lodash');
var pathModule = require('path');
var Promise = require('bluebird');
var fs = Promise.promisifyAll(require('fs'));
var mkdirpAsync = Promise.promisify(require('mkdirp'));
var rimrafAsync = Promise.promisify(require('rimraf'));
var chokidar = require('chokidar');
var uuid = require('node-uuid');
var debug = require('debug')('skrin');

function Skrin(options) {
    this.memoryCache = {};
    this._statCache = {}; // Absolute => stats object
    this.watcher = chokidar.watch(undefined, {
        alwaysStat: true
    });
    this.mutexByKey = {};
    this.waitForLock = Promise.resolve();

    var that = this;

    this.watcher.on('change', function (path, stats) {
        debug('watcher - change %s', path);
        that._statCache[path] = stats || null;
    }).on('unlink', function (path) {
        debug('watcher - unlink %s', path);
        that._statCache[path] = null;
    }).on('add', function (path) {
        debug('watcher - add %s', path);
        that._statCache[path] = null;
    });

    _.defaults(this, options);

    if (typeof this.populate !== 'function') {
        throw new Error('populate must be given as a function');
    }
    if (typeof this.persist === 'undefined') {
        this.persist = true;
    }
    if (this.persist) {
        if (typeof this.cacheDir !== 'string') {
            throw new Error('cacheDir must be given as a string');
        }
        debug('using cache dir %s', this.cacheDir);
    }
}

Skrin.prototype = {
    statAsync: function (path) {
        var that = this;
        if (this._statCache[path]) {
            return Promise.resolve(this._statCache[path]);
        } else {
            return fs.statAsync(path)
                .tap(function saveToStatCache(stats) {
                    that._statCache[path] = stats;
                });
        }
    },

    _keyToCachedFileName: function (key) {
        return key.replace(/\//g, '\x1d');
    },

    _deserializeCacheRecord: function (buffer) {
        var cacheRecord;

        for (var i = 0 ; i < buffer.length ; i += 1) {
            if (buffer[i] === 0x0a) {
                cacheRecord = JSON.parse(buffer.slice(0, i).toString('utf-8'));
                Object.keys(cacheRecord.payloads).forEach(function (payloadName) {
                    var payloadInfo = cacheRecord.payloads[payloadName];
                    cacheRecord.payloads[payloadInfo.name] = buffer.slice(payloadInfo.start, payloadInfo.end);
                });
                break;
            }
        }

        return cacheRecord;
    },

    _writeCacheRecordToDisc: function (key, cacheRecord) {
        var that = this;
        debug('_writeCacheRecordToDisc %s', key);

        var metadata = _.extend({}, cacheRecord); // Shallow copy
        metadata.payloads = {};
        var serializedPayloads = [];
        var offset = 0;

        Object.keys(cacheRecord.payloads).forEach(function (payloadName) {
            var payload = cacheRecord.payloads[payloadName];
            var serializedPayload = Buffer.isBuffer(payload) ? payload : new Buffer(payload, 'utf-8');
            metadata.payloads[payloadName] = {name: payloadName, start: offset, end: offset + serializedPayload.length};
            offset += serializedPayload.length;
            serializedPayloads.push(serializedPayload);
        });

        var tempFileName = pathModule.resolve(that.cacheDir, uuid());

        return fs.openAsync(tempFileName, 'ax')
            .caught(function handleMissingCacheDir(err) {
                debug('_writeCacheRecordToDisc - error opening %s for writing: %s', tempFileName, err.code);

                if (err.code === 'ENOENT') {
                    debug('_writeCacheRecordToDisc - creating cache dir');

                    return mkdirpAsync(that.cacheDir)
                        .then(function () {
                            return fs.openAsync(tempFileName, 'ax');
                        });
                } else {
                    throw err;
                }
            })
            .tap(function writeMetadataToFile(fd) {
                var jsonBuffer = new Buffer(JSON.stringify(metadata) + '\n');
                return fs.writeAsync(fd, new Buffer(jsonBuffer, 'utf-8'), 0, jsonBuffer.length, null);
            })
            .tap(function writePayloadsToFile(fd) {
                return Promise.each(serializedPayloads, function (serializedPayload) {
                    return fs.writeAsync(fd, serializedPayload, 0, serializedPayload.length, null);
                });
            })
            .then(function closeFile(fd) {
                return fs.closeAsync(fd);
            })
            .then(function moveTempFileToTarget() {
                debug('_writeCacheRecordToDisc - successfully wrote %s', tempFileName);
                return fs.renameAsync(tempFileName, pathModule.resolve(that.cacheDir, that._keyToCachedFileName(key)));
            })
            .tap(function () {
                debug('_writeCacheRecordToDisc - successfully renamed %s => %s', tempFileName, that._keyToCachedFileName(key));
            });
    },

    _assertCacheRecordFreshness: function (cacheRecord) {
        debug('_assertCacheRecordFreshness %s', cacheRecord.metadata.key);
        var that = this;

        return Promise.all(cacheRecord.metadata.sourcePaths.map(function (sourcePath) {
            debug('_assertCacheRecordFreshness - checking source path %s', sourcePath);
            return that.statAsync(sourcePath)
                .caught(function (err) {
                    debug('_assertCacheRecordFreshness - %s stat resulted in error %s', sourcePath, err.code);
                    throw err;
                })
                .then(function (stats) {
                    debug('_assertCacheRecordFreshness - comparing %d to %d', stats.mtime.getTime(), cacheRecord.metadata.minimumMtime);
                    if (stats.mtime.getTime() >= cacheRecord.metadata.minimumMtime) {
                        debug('_assertCacheRecordFreshness - source path %s not fresh', sourcePath);
                        throw new Error('not fresh');
                    }
                })
                .tap(function () {
                    debug('_assertCacheRecordFreshness - cache hit for %s', cacheRecord.metadata.key);
                });
        }))
        .then(function () {
            return cacheRecord;
        });
    },

    read: function (key) {
        debug('read %s', key);
        var that = this;

        if (that.wasDestructed) {
            return Promise.reject(new Error('read operations not permitted on already destructed instances'));
        }

        return that.waitForLock
            .then(function () {
                if (!that.mutexByKey[key]) {
                    debug('read - locking %s', key);

                    that.mutexByKey[key] = Promise.resolve()
                        .then(function getCacheRecord() {
                            var cacheRecord = that.memoryCache[key];

                            if (cacheRecord) {
                                debug('read - found memory cache record for %s', key);

                                return that._assertCacheRecordFreshness(cacheRecord)
                                    .caught(function () {
                                        return that._tryLoadCacheRecordFromDisc(key);
                                    });
                            } else {
                                return that._tryLoadCacheRecordFromDisc(key);
                            }
                        })
                        .tap(function storeRecordInMemory(cacheRecord) {
                            that.memoryCache[key] = cacheRecord;
                        })
                        .finally(function unlock() {
                            debug('read - unlocking %s', key);

                            that.mutexByKey[key] = null;
                        });
                } else {
                    debug('read - waiting for lock %s', key);
                }

                return that.mutexByKey[key];
            });
    },

    _tryLoadCacheRecordFromDisc: function (key) {
        var that = this;
        debug('_tryLoadCacheRecordFromDisc - %s', key);

        debug('_tryLoadCacheRecordFromDisc - %s - reading disk cache', key);

        return fs.readFileAsync(pathModule.resolve(that.cacheDir, that._keyToCachedFileName(key)))
            .then(function (buffer) {
                debug('_tryLoadCacheRecordFromDisc - %s - disk cache exists', key);
                var cacheRecord = that._deserializeCacheRecord(buffer);

                debug('_tryLoadCacheRecordFromDisc - %s - check disk cache freshness', key);

                return that._assertCacheRecordFreshness(cacheRecord)
                    .tap(function () {
                        debug('_tryLoadCacheRecordFromDisc - %s - disk cache was fresh');
                    })
                    .caught(function handleStaleCacheRecord() {
                        debug('_tryLoadCacheRecordFromDisc - %s - disk cache was stale, proceeding to build');

                        return that._populateAndAddToCache(key);
                    });
            })
            .caught(function handleMissingDiskCache(err) {
                if (err.code === 'ENOENT') {
                    debug('_tryLoadCacheRecordFromDisc - %s - ENOENT, proceeding to build it', key);
                    return that._populateAndAddToCache(key);
                } else {
                    debug('_tryLoadCacheRecordFromDisc - %s %s', key, err.code);
                    throw err;
                }
            });
    },

    _populateAndAddToCache: function (key) {
        var that = this;
        debug('_populateAndAddToCache %s', key);

        var startTime = Date.now();

        return this.populate(key)
            .then(function modifyCacheRecordMetadata(cacheRecord) {
                // Subtract 1000ms from minimumMtime.
                // Due to low mtime resolution (s rather than ms) a file modification within the same whole second will appear
                // as having happened before the startTime, which is incorrect. Therefore we don't trust the mtime unless
                // the difference is at least 1000ms
                cacheRecord.metadata.minimumMtime = startTime - 1000;
                cacheRecord.metadata.key = key;

                return cacheRecord;
            })
            .tap(function addFileWatchers(cacheRecord) {
                that.watcher.add(cacheRecord.metadata.sourcePaths);
            })
            .tap(function persistCacheRecordToDisc(cacheRecord) {
                if (that.persist) {
                    debug('_populateAndAddToCache - checking if we want to persist it %s', key, cacheRecord);

                    return that._assertCacheRecordFreshness(cacheRecord)
                        .then(function () {
                            return that._writeCacheRecordToDisc(key, cacheRecord);
                        })
                        .caught(function noop(err) {
                            // The cache record is no longer fresh. Just don't write it to disc.
                        });
                }
            });
    },

    purge: function () {
        var that = this;
        var nobodyCares = function () { return Promise.resolve(); };

        debug('purge - start');

        // Wait for possible previous lock to finish
        debug('purge - awaiting previous purge lock');
        that.waitForLock = that.waitForLock
            .catch(nobodyCares)
            .then(function resolveAllReadMutexes() {
                var mutexes = Object.keys(that.mutexByKey).map(function (key) {
                    return that.mutexByKey[key];
                }).filter(function (mutex) {
                    return mutex;
                });

                debug('purge - await %d read-mutexes', mutexes.length);

                return Promise.all(mutexes);
            })
            .catch(nobodyCares)
            .then(function deletePersistentCacheFolder() {
                debug('purge - delete persistent cache directory %s', that.cacheDir);
                return rimrafAsync(that.cacheDir);
            })
            .catch(nobodyCares)
            .then(function emptyMemoryCaches() {
                debug('purge - delete memory caches');

                that.memoryCache = {};
                that._statCache = {};
            })
            .catch(nobodyCares)
            .finally(function () {
                debug('purge - complete');
            });

        return that.waitForLock;
    },

    destruct: function () {
        debug('destruct');

        debug('destruct - closing file watchers');
        this.watcher.close();

        this.wasDestructed = true;
    }
};

module.exports = Skrin;
