import { NodeFileSystem } from "@effect/platform-node"
import { compile, emitEffectImported, emitPromise, write } from "@opencode-ai/httpapi-codegen"
import * as ProtocolErrors from "@opencode-ai/protocol/errors"
import { ClientApi, endpointNames, groupNames, omitEndpoints } from "../src/contract"
import { Effect } from "effect"
import { fileURLToPath } from "url"

const contract = compile(ClientApi, { groupNames, endpointNames, omitEndpoints })

// Each protocol error class is exported under its declared identifier, so its encoded
// Schema type replaces the structural copy. The generator imports only the ones in use.
const errorTypes = Object.fromEntries(
  Object.keys(ProtocolErrors).map((identifier) => [
    identifier,
    {
      name: `typeof ProtocolErrors.${identifier}.Encoded`,
      import: 'import type * as ProtocolErrors from "@opencode-ai/protocol/errors"',
    },
  ]),
)

await Effect.runPromise(
  Effect.all(
    [
      write(
        emitPromise(contract, {
          outputTypes: {
            "events.subscribe": {
              name: "OpenCodeEventEncoded",
              import: 'import type { OpenCodeEventEncoded } from "@opencode-ai/protocol/groups/event"',
            },
          },
          errorTypes,
        }),
        fileURLToPath(new URL("../src/generated", import.meta.url)),
      ),
      write(
        emitEffectImported(contract, { module: "../contract", api: "ClientApi" }),
        fileURLToPath(new URL("../src/generated-effect", import.meta.url)),
      ),
    ],
    { concurrency: 2, discard: true },
  ).pipe(Effect.provide(NodeFileSystem.layer)),
)
