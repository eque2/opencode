/**
 * Find a comment by marker in PR
 * @param {Object} params
 * @param {Object} params.github - GitHub API client
 * @param {Object} params.context - GitHub Actions context
 * @param {Object} params.core - GitHub Actions core
 * @param {string} params.marker - HTML marker to search for
 * @param {number} params.prNumber - PR number (optional, defaults to context PR)
 * @returns {Object|null} Comment object if found, null otherwise
 */
module.exports = async ({ github, context, core, marker, prNumber }) => {
  const issueNumber = prNumber || context.payload.pull_request.number;

  // Get all comments on the PR. One page holds at most 100, so a busy PR needs every page.
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner: context.repo.owner,
    repo: context.repo.repo,
    issue_number: issueNumber,
    per_page: 100,
  });

  console.log(`🔍 Searching for existing comment with marker: ${marker}`);
  console.log(`📊 Total comments on PR: ${comments.length}`);

  // Find existing comment (identified by HTML marker)
  const existingComment = comments.find((c) => c.body.includes(marker));

  if (existingComment) {
    console.log(
      `✓ FOUND existing comment (ID: ${existingComment.id}) - will update this comment`
    );
    core.setOutput('comment_id', existingComment.id.toString());
    return existingComment;
  } else {
    console.log(
      `✓ NOT FOUND - no existing comment with this marker - will create new comment`
    );
    core.setOutput('comment_id', '');
    return null;
  }
};
