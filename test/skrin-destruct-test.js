var Skrin = require('../lib/Skrin');
var pathModule = require('path');
var Promise = require('bluebird');
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

describe('Skrin.destruct', function () {
    it('should not throw when called', function () {
        var skrin = getSkrinInstance();

        expect(skrin.destruct.bind(skrin), 'not to throw');
    });

    it('should reject read operations when destruct was called', function () {
        var skrin = getSkrinInstance();

        skrin.destruct();

        expect(skrin.read(), 'to be rejected with', new Error('read operations not permitted on already destructed instances'));
    });
});
