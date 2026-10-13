/**
 * Extract PR information including Jira tickets
 * @param {Object} params
 * @param {Object} params.context - GitHub Actions context
 * @param {Object} params.core - GitHub Actions core
 * @returns {Object} PR information
 */
module.exports = async ({ context, core }) => {
  const pr = context.payload.pull_request;
  const title = pr.title;
  const body = pr.body || '';
  const prNumber = pr.number;

  // Extract Jira tickets (e.g., PROJ-123, ABC-456) - supports multiple tickets
  const jiraPattern = /([A-Z]+-\d+)/g;
  const matches = `${title} ${body}`.match(jiraPattern);
  const jiraTickets = matches ? matches.join(',') : '';

  core.setOutput('jira_ticket', jiraTickets);
  core.setOutput('pr_number', prNumber);
  core.setOutput('pr_title', title);

  if (!jiraTickets) {
    core.warning('No Jira ticket found in PR title or description');
  } else {
    core.info(`Found Jira tickets: ${jiraTickets}`);
  }

  return { jiraTickets, prNumber, title };
};
