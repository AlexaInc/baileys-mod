/**
 * `p-queue` (and its `eventemitter3` dep) ship ESM only, and Jest does not
 * transform node_modules by default — so requiring lib/Utils inside a test
 * blew up with "Cannot use import statement outside a module".
 */
module.exports = {
    testEnvironment: 'node',
    testMatch: ['**/tests/**/*.test.js'],
    transform: {
        '^.+\\.[cm]?js$': ['babel-jest', {
            plugins: ['@babel/plugin-transform-modules-commonjs']
        }]
    },
    transformIgnorePatterns: [
        'node_modules/(?!(p-queue|p-timeout|eventemitter3)/)'
    ]
}
