Perform an exhaustive analysis of the opencode codebase.

The purpose of the analysis is to find points at which logging might be captured. For example, prompts sent to LLMs, calls made to tools and so on. I would like every site captured and documented so that we can mount logging infrastructure.

Then, recommend and document six different patterns to capture logs using Effect logging. Provide code examples of how the logging might be mounted with pros and cons of each appraoch. It should be highly configurable with different layers of configuration switches and so on.

Write a connector / Effect logging sink for Datadog using your recommended pattern of these six.
