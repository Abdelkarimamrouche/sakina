module.exports = {
  presets: [
    [
      '@babel/preset-env',
      {
        targets: { chrome: '100' },
        modules: false,    // Keep ES modules — webpack handles bundling
        useBuiltIns: false,
      },
    ],
  ],
  env: {
    test: {
      presets: [
        ['@babel/preset-env', { targets: { node: 'current' } }],
      ],
    },
  },
};
