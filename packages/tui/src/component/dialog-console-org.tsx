import { createResource, createMemo, createSignal } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { Data, Effect, Result } from "effect"
import { DialogSelect } from "../ui/dialog-select"
import { useSDK } from "../context/sdk"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { useTheme } from "../context/theme"
import { errorMessage } from "../util/error"
import type { ExperimentalConsoleListOrgsResponse } from "@opencode-ai/sdk/v2"

type OrgOption = ExperimentalConsoleListOrgsResponse["orgs"][number]

/** The org list request failed. */
class LoadError extends Data.TaggedError("DialogConsoleOrg.LoadError")<{ readonly cause: unknown }> {}

// A URL that does not parse is shown as it is.
const accountHost = (url: string) => Result.try(() => new URL(url).host).pipe(Result.getOrElse(() => url))

const accountLabel = (item: Pick<OrgOption, "accountEmail" | "accountUrl">) =>
  `${item.accountEmail}  ${accountHost(item.accountUrl)}`

export function DialogConsoleOrg() {
  const sdk = useSDK()
  const dialog = useDialog()
  const toast = useToast()
  const { theme } = useTheme()

  const [loadError, setLoadError] = createSignal<unknown>()

  const [orgs] = createResource(() =>
    Effect.runPromise(
      Effect.tryPromise({
        try: () => sdk.client.experimental.console.listOrgs({}, { throwOnError: true }),
        catch: (cause) => new LoadError({ cause }),
      }).pipe(
        Effect.map((result) => result.data?.orgs ?? []),
        // Catch so the rejected resource never reaches the memos below: reading
        // orgs() in an errored state re-throws and tears down the dialog.
        Effect.catch((error) =>
          Effect.sync(() => {
            setLoadError(error.cause)
            return undefined
          }),
        ),
      ),
    ),
  )

  const showError = createMemo(() => Boolean(loadError()))

  const current = createMemo(() => orgs()?.find((item) => item.active))

  const options = createMemo(() => {
    if (showError()) return []
    const listed = orgs()
    if (listed === undefined) {
      return [
        {
          title: "Loading orgs…",
          value: "loading",
          onSelect: () => {},
        },
      ]
    }

    if (listed.length === 0) {
      return [
        {
          title: "No orgs found",
          value: "empty",
          onSelect: () => {},
        },
      ]
    }

    return listed
      .toSorted((a, b) => {
        const activeAccountA = a.active ? 0 : 1
        const activeAccountB = b.active ? 0 : 1
        if (activeAccountA !== activeAccountB) return activeAccountA - activeAccountB

        const accountCompare = accountLabel(a).localeCompare(accountLabel(b))
        if (accountCompare !== 0) return accountCompare

        return a.orgName.localeCompare(b.orgName)
      })
      .map((item) => ({
        title: item.orgName,
        value: item,
        category: accountLabel(item),
        categoryView: (
          <box flexDirection="row" gap={2}>
            <text fg={theme.accent}>{item.accountEmail}</text>
            <text fg={theme.textMuted}>{accountHost(item.accountUrl)}</text>
          </box>
        ),
        onSelect: async () => {
          if (item.active) {
            dialog.clear()
            return
          }

          await sdk.client.experimental.console.switchOrg(
            {
              accountID: item.accountID,
              orgID: item.orgID,
            },
            { throwOnError: true },
          )

          await sdk.client.instance.dispose()
          toast.show({
            message: `Switched to ${item.orgName}`,
            variant: "info",
          })
          dialog.clear()
        },
      }))
  })

  return (
    <DialogSelect<string | OrgOption>
      title="Switch org"
      options={options()}
      current={current()}
      renderFilter={!showError()}
      locked={showError()}
      // Leave emptyView out when there is no error, so the list keeps its default empty text.
      {...(showError()
        ? {
            emptyView: (
              <box paddingLeft={4} paddingRight={4}>
                <text fg={theme.error} attributes={TextAttributes.BOLD}>
                  Could not load orgs
                </text>
                <text fg={theme.textMuted}>{errorMessage(loadError())}</text>
              </box>
            ),
          }
        : {})}
    />
  )
}
