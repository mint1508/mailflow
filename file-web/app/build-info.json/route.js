export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  const buildSha = process.env.FILE_BUILD_SHA || process.env.NEXT_PUBLIC_FILE_BUILD_SHA || 'dev';
  const releaseVersion = process.env.FILE_RELEASE_VERSION || 'dev';
  const imageDigest = process.env.FILE_IMAGE_DIGEST || null;
  return Response.json(
    { build_sha: buildSha, release_version: releaseVersion, image_digest: imageDigest },
    { headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } },
  );
}
