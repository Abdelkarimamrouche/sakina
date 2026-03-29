/**
 * MusicShield — Webpack Configuration
 *
 * Builds four separate bundles:
 *   1. content.js    — injected into YouTube tabs
 *   2. background.js — MV3 service worker
 *   3. popup.js      — extension popup
 *   4. options.js    — options page
 *
 * TensorFlow.js is bundled INTO content.js to ensure it works
 * within the extension's Content Security Policy.
 */

const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const TerserPlugin = require('terser-webpack-plugin');

const isDev = process.env.NODE_ENV === 'development';
const ROOT = __dirname;
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');

module.exports = {
  mode: isDev ? 'development' : 'production',
  devtool: isDev ? 'inline-source-map' : false,

  entry: {
    content: path.join(SRC, 'content/index.js'),
    background: path.join(SRC, 'background/service-worker.js'),
    popup: path.join(SRC, 'popup/popup.js'),
    options: path.join(SRC, 'options/options.js'),
  },

  output: {
    path: DIST,
    filename: '[name].js',
    clean: true,
  },

  module: {
    rules: [
      // JavaScript / ES modules
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

      // CSS
      {
        test: /\.css$/,
        use: [MiniCssExtractPlugin.loader, 'css-loader'],
      },
    ],
  },

  resolve: {
    extensions: ['.js'],
    alias: {
      '@shared': path.join(SRC, 'shared'),
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
    // Don't split chunks — Chrome extensions need self-contained bundles
    // (or you need to declare all chunks in manifest web_accessible_resources)
    splitChunks: false,
  },

  plugins: [
    new MiniCssExtractPlugin({
      filename: '[name].css',
    }),

    // Copy popup HTML
    new HtmlWebpackPlugin({
      template: path.join(SRC, 'popup/index.html'),
      filename: 'popup.html',
      chunks: ['popup'],
      inject: false, // We manage script tags manually
    }),

    // Copy options HTML
    new HtmlWebpackPlugin({
      template: path.join(SRC, 'options/index.html'),
      filename: 'options.html',
      chunks: ['options'],
      inject: false,
    }),

    new CopyPlugin({
      patterns: [
        // Manifest
        { from: 'manifest.json', to: DIST },

        // Icons (you need to provide actual PNG files)
        { from: 'assets/icons', to: path.join(DIST, 'icons'), noErrorOnMissing: true },

        // YAMNet model files (bundled locally for reliability)
        { from: 'assets/yamnet', to: path.join(DIST, 'yamnet') },

        // TF.js WASM backend files (for non-WebGL environments)
        {
          from: 'node_modules/@tensorflow/tfjs-backend-wasm/dist/*.wasm',
          to: path.join(DIST, 'tfjs/[name][ext]'),
          noErrorOnMissing: true,
        },
      ],
    }),
  ],

  // Don't bundle Node.js builtins — this is a browser extension
  externals: {},
};
