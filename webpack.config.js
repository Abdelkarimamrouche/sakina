/**
 * Sakina — Webpack Configuration (v1.3 — i18n)
 */

const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const TerserPlugin = require('terser-webpack-plugin');

const isDev = process.env.NODE_ENV === 'development';
const ROOT = __dirname;
const SRC  = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');

module.exports = {
  mode: isDev ? 'development' : 'production',
  devtool: isDev ? 'inline-source-map' : false,

  entry: {
    content:    path.join(SRC, 'content/index.js'),
    background: path.join(SRC, 'background/service-worker.js'),
    popup:      path.join(SRC, 'popup/popup.js'),
    options:    path.join(SRC, 'options/options.js'),
    about:      path.join(SRC, 'about/about.js'),
  },

  output: {
    path: DIST,
    filename: '[name].js',
    clean: true,
  },

  module: {
    rules: [
      {
        test: /\.js$/,
        exclude: /node_modules/,
        use: {
          loader: 'babel-loader',
          options: {
            presets: [
              ['@babel/preset-env', {
                targets: { chrome: '100' },
                modules: false,
              }],
            ],
          },
        },
      },
      {
        test: /\.css$/,
        use: [MiniCssExtractPlugin.loader, 'css-loader'],
      },
    ],
  },

  resolve: {
    extensions: ['.js'],
    alias: {
      '@shared':  path.join(SRC, 'shared'),
      '@content': path.join(SRC, 'content'),
    },
  },

  optimization: {
    minimize: !isDev,
    minimizer: [
      new TerserPlugin({
        terserOptions: {
          compress: {
            pure_funcs: isDev ? [] : ['console.log', 'console.debug'],
          },
        },
      }),
    ],
    splitChunks: false,
  },

  plugins: [
    new MiniCssExtractPlugin({ filename: '[name].css' }),

    new HtmlWebpackPlugin({
      template: path.join(SRC, 'popup/index.html'),
      filename: 'popup.html',
      chunks: ['popup'],
      inject: false,
    }),

    new HtmlWebpackPlugin({
      template: path.join(SRC, 'options/index.html'),
      filename: 'options.html',
      chunks: ['options'],
      inject: false,
    }),

    new HtmlWebpackPlugin({
      template: path.join(SRC, 'about/about.html'),
      filename: 'about.html',
      chunks: ['about'],
      inject: false,
    }),

    new CopyPlugin({
      patterns: [
        { from: 'manifest.json', to: DIST },

        // ── i18n locale files (REQUIRED for chrome.i18n to work) ──
        { from: '_locales', to: path.join(DIST, '_locales') },

        { from: 'assets/icons',  to: path.join(DIST, 'icons'),  noErrorOnMissing: true },
        { from: 'assets/yamnet', to: path.join(DIST, 'yamnet'), noErrorOnMissing: true },

        {
          from: 'node_modules/@tensorflow/tfjs-backend-wasm/dist/*.wasm',
          to: path.join(DIST, 'tfjs/[name][ext]'),
          noErrorOnMissing: true,
        },
      ],
    }),
  ],

  externals: {},
};
