const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

module.exports = {
  entry: {
    content: './src/content/index.ts',
    background: './src/background.ts',
    popup: './src/popup/popup.ts',
    options: './src/options/options.ts',
  },
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: '[name].js',
    clean: true,
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
  module: {
    rules: [
      { test: /\.ts$/, use: 'ts-loader', exclude: /node_modules/ },
      { test: /\.css$/, use: ['style-loader', 'css-loader'] },
    ],
  },
  optimization: {
    splitChunks: false,
    runtimeChunk: false,
  },
  performance: { hints: false },
  devtool: false,
  plugins: [
    new CopyPlugin({
      patterns: [
        { from: 'src/manifest.json', to: 'manifest.json' },
        { from: 'src/popup/popup.html', to: 'popup.html' },
        { from: 'src/options/options.html', to: 'options.html' },
      ],
    }),
  ],
};
