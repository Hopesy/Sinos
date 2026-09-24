# Third-party source

The Cloudflare relay (`relay/src/index.ts`, `room.ts`, `pairing.ts`) and phone
pairing primitives (`src-ui/src/remote/pair/crypto.ts`, `encoding.ts` and crypto
tests) are adapted from EnsoCode, copyright (c) 2026 EnsoAI Team, under MIT.
The mobile layout and visual tokens also follow EnsoCode's phone client.
See [EnsoCode-LICENSE.txt](EnsoCode-LICENSE.txt) for the full license.

Upstream: https://github.com/J3n5en/EnsoCode

Coffee uses its own Rust host, CLI adapters, and mobile workspace protocol.
