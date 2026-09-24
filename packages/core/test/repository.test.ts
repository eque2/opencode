import { describe, expect, test } from "bun:test"
import { Option, Result } from "effect"
import path from "path"
import { pathToFileURL } from "url"
import { Repository } from "@opencode-ai/core/repository"

describe("Repository", () => {
  test("parses github shorthand and builds an explicit-root cache path", () => {
    const reference = Result.getOrThrow(Repository.parseRemote("owner/repo"))

    expect(reference).toMatchObject({
      host: "github.com",
      path: "owner/repo",
      segments: ["owner", "repo"],
      owner: "owner",
      repo: "repo",
      remote: "https://github.com/owner/repo.git",
      label: "owner/repo",
    })
    expect(Repository.cachePath("/cache", reference)).toBe(path.join("/cache", "github.com", "owner", "repo"))
    expect(Repository.cachePath("/cache", reference, "main")).toBe(
      path.join("/cache", "github.com", "owner", "repo@main"),
    )
    expect(Repository.cachePath("/cache", reference, "feature/x")).toBe(
      path.join("/cache", "github.com", "owner", "repo@feature%2Fx"),
    )
    expect(Repository.cacheIdentity(reference)).toBe("github.com/owner/repo")
  })

  test("parses host path and scp remote references", () => {
    expect(Result.getOrThrow(Repository.parseRemote("gitlab.com/group/repo"))).toMatchObject({
      host: "gitlab.com",
      path: "group/repo",
      remote: "https://gitlab.com/group/repo.git",
      label: "gitlab.com/group/repo",
    })
    expect(Result.getOrThrow(Repository.parseRemote("git@github.com:owner/repo.git"))).toMatchObject({
      host: "github.com",
      path: "owner/repo",
      remote: "git@github.com:owner/repo.git",
      label: "owner/repo",
    })
  })

  test("keeps local file repositories distinct from remote repositories", () => {
    const localPath = path.resolve("repo.git")
    const reference = Repository.parse(pathToFileURL(localPath).href)

    expect(Option.getOrThrow(reference)).toMatchObject({ host: "file", protocol: "file:", label: localPath })
    expect(Option.exists(reference, Repository.isFile)).toBe(true)
    expect(Option.exists(reference, Repository.isRemote)).toBe(false)
    expect(() => Result.getOrThrow(Repository.parseRemote(pathToFileURL(localPath).href))).toThrow(
      Repository.UnsupportedLocalRepositoryError,
    )
  })

  test("rejects unsafe remote references and branches with typed errors", () => {
    expect(() => Result.getOrThrow(Repository.parseRemote("not-a-repo"))).toThrow(Repository.InvalidReferenceError)
    expect(() => Result.getOrThrow(Repository.parseRemote("git@github.com:../../../etc/passwd"))).toThrow(
      Repository.InvalidReferenceError,
    )
    expect(() => Result.getOrThrow(Repository.validateBranch("feature/docs.v1"))).not.toThrow()
    expect(() => Result.getOrThrow(Repository.validateBranch("-bad"))).toThrow(Repository.InvalidBranchError)
    expect(() => Result.getOrThrow(Repository.validateBranch("bad..branch"))).toThrow(Repository.InvalidBranchError)
    expect(() => Result.getOrThrow(Repository.validateBranch("bad branch"))).toThrow(Repository.InvalidBranchError)
  })

  test("compares cache identity independent of input spelling", () => {
    const shorthand = Result.getOrThrow(Repository.parseRemote("owner/repo"))

    expect(
      Repository.same(shorthand, Result.getOrThrow(Repository.parseRemote("https://github.com/owner/repo.git"))),
    ).toBe(true)
    expect(Repository.same(shorthand, Result.getOrThrow(Repository.parseRemote("github.com/owner/repo")))).toBe(true)
  })
})
