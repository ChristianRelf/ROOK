# 0002 -- SeaweedFS for local object storage

**Status:** accepted
**Date:** 2026-10-27

## Context

The spec requires S3-compatible object storage that runs locally with no cloud
account. The two obvious choices both turned out to be unavailable.

**MinIO is gated.** Its images now require registry authentication on both
registries:

```text
docker.io/minio/minio  -> 401 UNAUTHORIZED (anonymous pull)
quay.io/minio/minio    -> 401 UNAUTHORIZED (anonymous pull)
```

**LocalStack starts and then exits.** Its current image requires a paid token:

```text
License activation failed!
Reason: No credentials were found in the environment.
Please set the LOCALSTACK_AUTH_TOKEN variable to a valid auth token.
...
Localstack returning with exit code 55.
```

Both were established by attempting them, not inferred from documentation.

## Decision

Use **SeaweedFS** (`chrislusf/seaweedfs:4.51`) for local development.

## Why

- Apache-2.0, and pulls anonymously -- so `pnpm infra:up` works on a fresh
  clone with no account anywhere.
- Its S3 gateway covers everything the pipeline needs: presigned PUT and GET,
  `HEAD`, range requests, bucket policies.
- Declaring an identity in `s3.json` disables anonymous access, so the bucket
  is genuinely private and the presigned-URL flow is exercised properly rather
  than silently accepting unsigned requests.
- CORS is a server flag (`-s3.allowedOrigins`), simpler than applying a bucket
  CORS policy at startup.
- Small: a single Go binary that starts in a few seconds.

Verified against it end to end: presigned PUT accepted, byte-identical round
trip, unauthenticated GET refused with 403, expired signature refused, and a
range read returning exactly the requested prefix.

## Consequences

- **This affects development only.** Production uses whatever the deployment
  provides -- real S3, R2, B2, or a self-hosted MinIO if the operator has
  credentials. Nothing in the code is SeaweedFS-specific; it all goes through
  `ObjectStoragePort`, and switching is configuration.
- SeaweedFS is less widely deployed than MinIO, so its S3 edge cases are less
  travelled. Mitigated by the integration suite exercising real behaviour
  rather than mocking it.
- One discovery worth recording, because it would have broken against real S3
  too: the AWS SDK adds a checksum header to `PutObject` by default since
  v3.729, which **breaks presigned PUTs**. The checksum is computed when the
  URL is signed, with no body present, so the signature commits to the digest
  of nothing and storage rejects the real upload with `BadDigest`. Fixed with
  `requestChecksumCalculation: 'WHEN_REQUIRED'`.

## Alternatives considered

- **Garage** -- Apache-2.0 and lightweight, but needs cluster layout
  initialisation (`garage layout assign`) before it serves anything, which is
  more friction than a plain `docker compose up`.
- **adobe/s3mock** -- a test mock that does not validate signatures, so the
  presigned-URL flow would appear to work while proving nothing.
- **Real S3 for development** -- rejected outright: the spec requires no cloud
  account.
