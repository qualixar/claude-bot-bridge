/** The ROOT public key (Ed25519, SPKI PEM); same as plugin/release-signing-public.pem and keys/root-public.pem (tests check).
 *  The root signs keys/keyset.json and nothing else; the rules and binary keys it lists sign rules and manifests (keyset.js).
 *  The root private key stays offline on the maintainer's machine: not in this repository, not in GitHub. */
export const RELEASE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAiBMcVC9bskstLcP7sdhHD+dWPJpqsneHQ74/hzIQQSM=
-----END PUBLIC KEY-----
`;
