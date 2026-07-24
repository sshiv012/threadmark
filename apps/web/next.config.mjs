/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: [
    'postgres',
    'ioredis',
    '@opensearch-project/opensearch',
    '@threadmark/db',
    '@threadmark/model-router',
    '@threadmark/retrieval',
    '@threadmark/search',
  ],
  webpack: (config, { isServer }) => {
    if (isServer) {
      // Never bundle the native ONNX runtime / transformers (contain .node
      // binaries + platform variants); require them at runtime instead.
      config.externals.push({
        '@huggingface/transformers': 'commonjs @huggingface/transformers',
        'onnxruntime-node': 'commonjs onnxruntime-node',
        sharp: 'commonjs sharp',
      });
    }
    return config;
  },
};

export default nextConfig;
