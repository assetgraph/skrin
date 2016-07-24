var _ = require('lodash');
var pathModule = require('path');
var Promise = require('bluebird');
var fs = Promise.promisifyAll(require('fs'));
var mkdirpAsync = Promise.promisify(require('mkdirp'));
var chokidar = require('chokidar');
var uuid = require('node-uuid');
var debug = require('debug')('skrin');

function Skrin(options) {
    this.memoryCache = {};
    this._statCache = {}; // Absolute => stats object
    this.watcher = chokidar.watch();
    this.mutexByKey = {};
    var that = this;
    this.watcher.on('change', function (path, stats) {
        debug('change %s', path);
        that._statCache[path] = stats;
    }).on('unlink', function (path) {
        debug('unlink %s', path);
        that._statCache[path] = null;
    }).on('add', function (path) {
        debug('add %s', path);
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
            return fs.statAsync(path).tap(function (stats) {
                that._statCache[path] = stats;
            });
        }
    },

    _keyToCachedFileName: function (key) {
        return key.replace(/\//g, '\x1d');
    },

    _deserializeCacheRecord: function (buffer) {
        var cacheRecord = {};
        for (var i = 0 ; i < buffer.length ; i += 1) {
            if (buffer[i] === 0x0a) {
                cacheRecord.metadata = JSON.parse(buffer.slice(0, i).toString('utf-8'));
                cacheRecord.payloads = {};
                cacheRecord.metadata.payloads.forEach(function (payloadInfo) {
                    cacheRecord.payloads[payloadInfo.name] = buffer.slice(payloadInfo.start, payloadInfo.end);
                });
                break;
            }
        }
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
            .caught(function (err) {
                debug('error opening %s for writing: %s', tempFileName, err.code);
                if (err.code === 'ENOENT') {
                    debug('creating cache dir');
                    return mkdirpAsync(that.cacheDir)
                        .then(function () {
                            return fs.openAsync(tempFileName, 'ax');
                        });
                } else {
                    throw err;
                }
            })
            .tap(function (fd) {
                var jsonBuffer = new Buffer(JSON.stringify(metadata) + '\n');
                return fs.writeAsync(fd, new Buffer(jsonBuffer, 'utf-8'), 0, jsonBuffer.length, null);
            })
            .tap(function (fd) {
                return Promise.each(serializedPayloads, function (serializedPayload) {
                    return fs.writeAsync(fd, serializedPayload, 0, serializedPayload.length, null);
                });
            })
            .then(function (fd) {
                return fs.closeAsync(fd);
            })
            .then(function () {
                debug('successfully wrote %s', tempFileName);
                return fs.renameAsync(tempFileName, pathModule.resolve(that.cacheDir, that._keyToCachedFileName(key)));
            })
            .tap(function () {
                debug('successfully renamed %s => %s', tempFileName, that._keyToCachedFileName(key));
            });
    },

    _assertCacheRecordFreshness: function (cacheRecord) {
        debug('_assertCacheRecordFreshness %s', cacheRecord.metadata.key);
        var that = this;
        return Promise.all(cacheRecord.metadata.sourcePaths.map(function (sourcePath) {
            debug('checking source path %s', sourcePath);
            return that.statAsync(sourcePath)
                .then(function (stats) {
                    debug('comparing %d to %d', stats.mtime.getTime(), cacheRecord.metadata.minimumMtime);
                    if (stats.mtime.getTime() >= cacheRecord.metadata.minimumMtime) {
                        debug('source path %s not fresh', sourcePath);
                        throw new Error('not fresh');
                    }
                }, function (err) {
                    debug('%s stat resulted in error %s', sourcePath, err.code);
                    throw err;
                }).tap(function () {
                    debug('cache hit for %s', cacheRecord.metadata.key);
                });
        })).then(function () {
            return cacheRecord;
        });
    },

    read: function (key) {
        debug('read %s', key);
        var that = this;
        if (!that.mutexByKey[key]) {
            debug('locking %s', key);
            that.mutexByKey[key] = Promise.resolve().then(function () {
                var cacheRecord = that.memoryCache[key];
                if (cacheRecord) {
                    debug('found memory cache record for %s', key);
                    return that._assertCacheRecordFreshness(cacheRecord).caught(function () {
                        return that._tryLoadCacheRecordFromDisc(key);
                    });
                } else {
                    return that._tryLoadCacheRecordFromDisc(key);
                }
            })
            .tap(function (cacheRecord) {
                that.memoryCache[key] = cacheRecord;
            })
            .finally(function () {
                that.mutexByKey[key] = null;
            });
        } else {
            debug('waiting for lock %s', key);
        }
        return that.mutexByKey[key];
    },

    _tryLoadCacheRecordFromDisc: function (key) {
        var that = this;
        debug('_tryLoadCacheRecordFromDisc %s', key);
        return fs.readFileAsync(this._keyToCachedFileName(key)).then(function (buffer) {
            var cacheRecord = that._deserializeCacheRecord(buffer);
            return that._assertCacheRecordFreshness(cacheRecord).caught(function () {
                return that._populateAndAddToCache(key);
            });
        }, function (err) {
            if (err.code === 'ENOENT') {
                debug('_tryLoadCacheRecordFromDisc %s ENOENT, proceeding to build it', key);
                return that._populateAndAddToCache(key);
            } else {
                debug('_tryLoadCacheRecordFromDisc %s %s', key, err.code);
                throw err;
            }
        });
    },

    _populateAndAddToCache: function (key) {
        var that = this;
        debug('_populateAndAddToCache %s', key);
        var startTime = Date.now();
        return this.populate(key).then(function (cacheRecord) {
            cacheRecord.metadata.minimumMtime = startTime;
            cacheRecord.metadata.key = key;
            return cacheRecord;
        }).tap(function (cacheRecord) {
            that.watcher.add(cacheRecord.metadata.sourcePaths);
            if (that.persist) {
                debug('checking if we want to persist it %s', key);
                return that._assertCacheRecordFreshness(cacheRecord).then(function () {
                    return that._writeCacheRecordToDisc(key, cacheRecord);
                }, function (err) {
                    // The cache record is no longer fresh. Just don't write it to disc.
                });
            }
        });
    }
};

module.exports = Skrin;
