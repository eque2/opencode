import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { eq } from "drizzle-orm"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { Effect, Layer, Option, Schema, Context } from "effect"

import { Database } from "@opencode-ai/core/database/database"
import { AccountStateTable, AccountTable } from "@opencode-ai/core/account/sql"
import { AccessToken, AccountID, AccountRepoError, Info, OrgID, RefreshToken } from "./schema"
import { normalizeServerUrl } from "./url"

export type AccountRow = (typeof AccountTable)["$inferSelect"]

const ACCOUNT_STATE_ID = 1

export interface Interface {
  readonly active: () => Effect.Effect<Option.Option<Info>, AccountRepoError>
  readonly list: () => Effect.Effect<Info[], AccountRepoError>
  readonly remove: (accountID: AccountID) => Effect.Effect<void, AccountRepoError>
  readonly use: (accountID: AccountID, orgID: Option.Option<OrgID>) => Effect.Effect<void, AccountRepoError>
  readonly getRow: (accountID: AccountID) => Effect.Effect<Option.Option<AccountRow>, AccountRepoError>
  readonly persistToken: (input: PersistTokenInput) => Effect.Effect<void, AccountRepoError>
  readonly persistAccount: (input: PersistAccountInput) => Effect.Effect<void, AccountRepoError>
}

export interface PersistTokenInput {
  accountID: AccountID
  accessToken: AccessToken
  refreshToken: RefreshToken
  expiry: Option.Option<number>
}

export interface PersistAccountInput {
  id: AccountID
  email: string
  url: string
  accessToken: AccessToken
  refreshToken: RefreshToken
  expiry: number
  orgID: Option.Option<OrgID>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/AccountRepo") {}

export const use = serviceUse(Service)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const decode = Schema.decodeUnknownSync(Info)

    const query = <A, E>(effect: Effect.Effect<A, E>) =>
      effect.pipe(Effect.mapError((cause) => new AccountRepoError({ message: "Database operation failed", cause })))

    const current = Effect.fnUntraced(function* () {
      const state = yield* db.select().from(AccountStateTable).where(eq(AccountStateTable.id, ACCOUNT_STATE_ID)).get()
      if (!state?.active_account_id) return Option.none()
      const account = yield* db.select().from(AccountTable).where(eq(AccountTable.id, state.active_account_id)).get()
      if (!account) return Option.none()
      return Option.some({ ...account, active_org_id: state.active_org_id })
    })

    const state = (accountID: AccountID, orgID: Option.Option<OrgID>) => {
      const id = Option.getOrNull(orgID)
      return db
        .insert(AccountStateTable)
        .values({ id: ACCOUNT_STATE_ID, active_account_id: accountID, active_org_id: id })
        .onConflictDoUpdate({
          target: AccountStateTable.id,
          set: { active_account_id: accountID, active_org_id: id },
        })
        .run()
    }

    const active = Effect.fn("AccountRepo.active")(() =>
      query(current()).pipe(Effect.map(Option.map(decode))),
    )

    const list = Effect.fn("AccountRepo.list")(() =>
      query(
        db
          .select()
          .from(AccountTable)
          .all()
          .pipe(
            Effect.map((rows) =>
              // eslint-disable-next-line effect/no-null-use-option -- (b) the decode input is the Encoded form of Info, whose active_org_id is Schema.NullOr(OrgID) to mirror the nullable SQL column
              rows.map((row: AccountRow) => decode({ ...row, active_org_id: null })),
            ),
          ),
      ),
    )

    const remove = Effect.fn("AccountRepo.remove")((accountID: AccountID) =>
      query(
        db.transaction((tx) =>
          Effect.gen(function* () {
            yield* tx
              .update(AccountStateTable)
              // eslint-disable-next-line effect/no-null-use-option -- (a) Drizzle update().set() writes SQL NULL only from a null value; undefined skips the column
              .set({ active_account_id: null, active_org_id: null })
              .where(eq(AccountStateTable.active_account_id, accountID))
              .run()
            yield* tx.delete(AccountTable).where(eq(AccountTable.id, accountID)).run()
          }),
        ),
      ).pipe(Effect.asVoid),
    )

    const use = Effect.fn("AccountRepo.use")((accountID: AccountID, orgID: Option.Option<OrgID>) =>
      query(state(accountID, orgID)).pipe(Effect.asVoid),
    )

    const getRow = Effect.fn("AccountRepo.getRow")((accountID: AccountID) =>
      query(db.select().from(AccountTable).where(eq(AccountTable.id, accountID)).get()).pipe(
        Effect.map(Option.fromNullishOr),
      ),
    )

    const persistToken = Effect.fn("AccountRepo.persistToken")((input: PersistTokenInput) =>
      query(
        db
          .update(AccountTable)
          .set({
            access_token: input.accessToken,
            refresh_token: input.refreshToken,
            token_expiry: Option.getOrNull(input.expiry),
          })
          .where(eq(AccountTable.id, input.accountID))
          .run(),
      ).pipe(Effect.asVoid),
    )

    const persistAccount = Effect.fn("AccountRepo.persistAccount")((input: PersistAccountInput) =>
      query(
        db.transaction((tx) =>
          Effect.gen(function* () {
            const url = normalizeServerUrl(input.url)

            yield* tx
              .insert(AccountTable)
              .values({
                id: input.id,
                email: input.email,
                url,
                access_token: input.accessToken,
                refresh_token: input.refreshToken,
                token_expiry: input.expiry,
              })
              .onConflictDoUpdate({
                target: AccountTable.id,
                set: {
                  email: input.email,
                  url,
                  access_token: input.accessToken,
                  refresh_token: input.refreshToken,
                  token_expiry: input.expiry,
                },
              })
              .run()
            yield* state(input.id, input.orgID)
          }),
        ),
      ).pipe(Effect.asVoid),
    )

    return Service.of({
      active,
      list,
      remove,
      use,
      getRow,
      persistToken,
      persistAccount,
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [Database.node] })

export * as AccountRepo from "./repo"
