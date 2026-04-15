const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');

module.exports = (env, argv) => {
  const isDev = argv.mode === 'development';

  return {
    mode: argv.mode || 'development',
    devtool: isDev ? 'cheap-module-source-map' : false,

    entry: {
      background:          './src/background.js',
      content:             './src/content.js',
      sidepanel:           './src/sidepanel/sidepanel.js',
      dashboard:           './src/dashboard/dashboard.js',
      offscreen:           './src/offscreen/offscreen.js',
      'inference.worker':  './src/workers/inference.worker.js',
      'embedder.worker':   './src/workers/embedder.worker.js',
      'graph.worker':      './src/workers/graph.worker.js',
    },

    output: {
      path:     path.resolve(__dirname, 'dist'),
      filename: '[name].js',
      clean:    false,
    },

    module: {
      rules: [
        {
          test: /\.css$/i,
          use:  [MiniCssExtractPlugin.loader, 'css-loader'],
        },
      ],
    },

    plugins: [
      new MiniCssExtractPlugin({ filename: '[name].css' }),

      new HtmlWebpackPlugin({
        template: './src/sidepanel/sidepanel.html',
        filename: 'sidepanel/sidepanel.html',
        chunks:   ['sidepanel'],
        inject:   'body',
      }),

      new HtmlWebpackPlugin({
        template: './src/dashboard/dashboard.html',
        filename: 'dashboard/dashboard.html',
        chunks:   ['dashboard'],
        inject:   'body',
      }),

      new HtmlWebpackPlugin({
        template: './src/offscreen/offscreen.html',
        filename: 'offscreen/offscreen.html',
        chunks:   ['offscreen'],
        inject:   'body',
      }),

      new CopyPlugin({
        patterns: [
          { from: 'src/manifest.json', to: 'manifest.json' },
          { from: 'src/icons',         to: 'icons' },
          { from: 'node_modules/@mediapipe/tasks-genai/wasm', to: 'wasm/genai', noErrorOnMissing: true },
          { from: 'node_modules/@mediapipe/tasks-text/wasm',  to: 'wasm/text',  noErrorOnMissing: true },
        ],
      }),
    ],

    resolve: {
      extensions: ['.js'],
      fallback: { fs: false, path: false, crypto: false },
    },

    performance: {
      // WASM files are large by nature — suppress the noise
      hints: false,
    },

    optimization: {
      splitChunks: {
        // Don't split workers or the offscreen document
        chunks: (chunk) => !chunk.name?.includes('worker') && chunk.name !== 'offscreen',
      },
    },
  };
};
