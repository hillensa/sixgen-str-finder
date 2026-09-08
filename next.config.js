/** @type {import('next').NextConfig} */
module.exports = {
  reactStrictMode: true,
  poweredByHeader: false,          // don't advertise the framework
  // A build must not ship with type errors or lint failures; both default to
  // failing the build in Next, and they are pinned here so nobody quietly
  // relaxes them under deadline pressure.
  typescript: { ignoreBuildErrors: false },
  eslint: { ignoreDuringBuilds: false },
};
