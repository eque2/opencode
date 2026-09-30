/**
 * Delete all comments with a specific marker
 * @param {Object} params
 * @param {Object} params.github - GitHub API client
 * @param {Object} params.context - GitHub Actions context
 * @param {string} params.marker - HTML marker to search for
 * @param {number} params.prNumber - PR number (optional, defaults to context PR)
 * @returns {number} Number of comments deleted
 */
module.exports = async ({ github, context, marker, prNumber }) => {
  const issueNumber = prNumber || context.payload.pull_request.number;

  // Get all comments on the PR
  const { data: comments } = await github.rest.issues.listComments({
    owner: context.repo.owner,
    repo: context.repo.repo,
    issue_number: issueNumber,
  });

  let deletedCount = 0;

  console.log(`🔍 Searching for existing comments with marker: ${marker}`);
  console.log(`📊 Total comments found on PR: ${comments.length}`);

  // Delete comments with the specified marker
  for (const comment of comments) {
    if (comment.body.includes(marker)) {
      await github.rest.issues.deleteComment({
        owner: context.repo.owner,
        repo: context.repo.repo,
        comment_id: comment.id,
      });
      console.log(`🗑️  Deleted comment ${comment.id} with marker`);
      deletedCount++;
    }
  }

  if (deletedCount === 0) {
    console.log(
      `✓ No existing comments found with marker - will create new comment`
    );
  } else {
    console.log(
      `✓ Deleted ${deletedCount} comment(s) with marker - will create new comment`
    );
  }

  return deletedCount;
};
