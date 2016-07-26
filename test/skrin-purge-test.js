var Skrin = require('../lib/Skrin');
var pathModule = require('path');
var Promise = require('bluebird');
var fs = Promise.promisifyAll(require('fs'));
var sinon = require('sinon');
var expect = require('unexpected').clone().use(require('unexpected-sinon'));
var getTemporaryFilePath = require('gettemporaryfilepath');

function getSkrinInstance() {
    var pathToFooTxt = pathModule.resolve(__dirname, '..', 'testdata', 'sourceDir', 'foo.txt');

    return new Skrin({
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
}

describe('Skrin.purge', function () {
    it('should not throw when called', function () {
        var skrin = getSkrinInstance();

        return expect(skrin.purge.bind(skrin), 'not to throw');
    });

    it('should clean out caches', function () {
        var skrin = getSkrinInstance();

        return skrin.read('foo.txt')
            .tap(function () {
                expect(skrin.mutexByKey, 'to exhaustively satisfy', {
                    'foo.txt': null
                });

                expect(skrin.memoryCache, 'to satisfy', {
                    'foo.txt': {
                        metadata: {
                            key: 'foo.txt'
                        },
                        payloads: {
                            transpiledOutput: 'the transpiled output of foo.txt',
                            sourceMap: 'the source map of foo.txt'
                        }
                    }
                });

                expect(skrin._statCache, 'to have keys satisfying', function (key) {
                    return key.match(/foo.txt$/);
                });
            })
            .tap(skrin.purge.bind(skrin))
            .tap(function () {
                expect(skrin.mutexByKey, 'to exhaustively satisfy', {
                    'foo.txt': null
                });

                expect(skrin.memoryCache, 'to be empty');
                expect(skrin._statCache, 'to be empty');
            })
            .then(function (cacheRecord) {
                return expect(fs.statAsync(skrin.cacheDir), 'to be rejected with', { code: 'ENOENT' });
            });
    });
});
