var Skrin = require('../lib/Skrin');
var pathModule = require('path');
var Promise = require('bluebird');
var fs = Promise.promisifyAll(require('fs'));
var sinon = require('sinon');
var expect = require('unexpected').clone().use(require('unexpected-sinon'));
var getTemporaryFilePath = require('gettemporaryfilepath');

function touchAsync(path) {
    var now = new Date();
    return fs.utimesAsync(path, now, now);
}

describe('Skrin', function () {
    var pathToFooTxt = pathModule.resolve(__dirname, '..', 'testdata', 'sourceDir', 'foo.txt');
    var skrin;
    beforeEach(function () {
        skrin = new Skrin({
            cacheDir: getTemporaryFilePath(),
            populate: sinon.spy(function (key) {
                var startCompileTime = Date.now();
                return Promise.resolve().delay(10).then(function () {
                    return {
                        metadata: {
                            sourcePaths: [pathToFooTxt],
                            compileTime: Date.now() - startCompileTime
                        },
                        payloads: {
                            transpiledOutput: 'the transpiled output of ' + key,
                            sourceMap: 'the source map of ' + key
                        }
                    };
                });
            })
        });
    });

    afterEach(function () {
        return skrin.purge()
            .then(skrin.destruct.bind(skrin));
    });

    it('should serve cache records from memory when they are assumed to be fresh', function () {
        var spy = sinon.spy(skrin, '_tryLoadCacheRecordFromDisc');

        return skrin.read('memcache.txt')
            .then(function (cacheRecord) {
                expect(spy, 'was called once');
            })
            .then(function () {
                return skrin.read('memcache.txt');
            })
            .then(function (cacheRecord) {
                expect(spy, 'was called once');
            });
    });

    it('should serve cache records from disk when they are assumed to be fresh', function () {
        var spy = sinon.spy(skrin, '_tryLoadCacheRecordFromDisc');

        return skrin.read('memcache.txt')
            .then(function (cacheRecord) {
                expect(spy, 'was called once');
            })
            .then(function () {
                expect(skrin.memoryCache, 'to satisfy', {
                    'memcache.txt': {
                        metadata: { key: 'memcache.txt' }
                    }
                });

                delete skrin.memoryCache['memcache.txt'];

                expect(skrin.memoryCache, 'to be empty');

                return skrin.read('memcache.txt');
            })
            .then(function (cacheRecord) {
                expect(spy, 'was called twice');

                expect(skrin.memoryCache, 'to satisfy', {
                    'memcache.txt': {
                        metadata: { key: 'memcache.txt' }
                    }
                });
            });
    });

    it('should expose a method with read-but-write-if-it-is-not-there semantics', function () {
        return Promise.all([
            skrin.read('read-write-if-nonexist.txt').then(function (cacheRecord) {
                expect(cacheRecord, 'to satisfy', {
                    metadata: {
                        compileTime: expect.it('to be less than', 100)
                    },
                    payloads: {
                        transpiledOutput: 'the transpiled output of read-write-if-nonexist.txt',
                        sourceMap: 'the source map of read-write-if-nonexist.txt'
                    }
                });
            }),
            skrin.read('read-write-if-nonexist.txt').then(function (cacheRecord) {
                expect(cacheRecord, 'to satisfy', {
                    metadata: {
                        compileTime: expect.it('to be less than', 100)
                    },
                    payloads: {
                        transpiledOutput: 'the transpiled output of read-write-if-nonexist.txt',
                        sourceMap: 'the source map of read-write-if-nonexist.txt'
                    }
                });
            })
        ]).then(function () {
            expect(skrin.populate, 'was called once');
            return fs.readFileAsync(pathModule.resolve(skrin.cacheDir, skrin._keyToCachedFileName('read-write-if-nonexist.txt')));
        }).then(function (contents) {
            var metadataStr = contents.toString().replace(/\n[\s\S]*$/, '');
            expect(JSON.parse(metadataStr), 'to satisfy', {
                payloads: {
                    transpiledOutput: {
                        start: 0,
                        end: 'the transpiled output of read-write-if-nonexist.txt'.length
                    },
                    sourceMap: {
                        start: 'the transpiled output of read-write-if-nonexist.txt'.length,
                        end: 'the transpiled output of read-write-if-nonexist.txt'.length + 'the source map of read-write-if-nonexist.txt'.length
                    }
                }
            });
        });
    });

    it('should repopulate the cache when a source file changes', function () {
        expect.addAssertion('<date> to be after <date>', function (expect, subject, value) {
            expect(subject.getTime(), 'to be greater than', value.getTime());
        });

        this.timeout(5000);

        var stat1;
        return skrin.read('repopulate-on-update.txt')
            .then(function (cacheRecord) {
                return expect(cacheRecord.metadata, 'to satisfy', {
                    key: 'repopulate-on-update.txt',
                    minimumMtime: expect.it('to be a number')
                });
            })
            .then(function () {
                expect(skrin.populate, 'was called once');

                expect(skrin._statCache[pathToFooTxt], 'to satisfy', {
                    mtime: expect.it('to be a', 'date')
                });

                stat1 = skrin._statCache[pathToFooTxt];

                return touchAsync(pathToFooTxt);
            })
            .delay(300)
            .then(function () {
                // Make sure that the watcher has kicked in:
                expect(skrin._statCache[pathToFooTxt], 'not to be', stat1);

                expect(skrin._statCache[pathToFooTxt], 'to satisfy', {
                    mtime: expect.it('to be after', stat1.mtime)
                });

                // expect(skrin._statCache[pathToFooTxt].mtime, 'to be after', mtime1);
                return skrin.read('repopulate-on-update.txt');
            })
            .then(function (cacheRecord) {
                expect(cacheRecord.metadata, 'to satisfy', {
                    key: 'repopulate-on-update.txt',
                    minimumMtime: expect.it('to be a number')
                });
                expect(skrin.populate, 'was called twice');
            });
    });
});
