This repo currently captures logs that are sent to a remote logger, Datadog. We want to change the architecture of this to send them instead to a proxy which internally will decide what to do with them.

So:

## Build the proxy

Build a server as a docker container that will act as this proxy, forwarding messages to Datadog
Datadog will be internal to this proxy - this opencode fork is entirely agnostic to the actual logging mechanism, if any logging goes on at all
opencode can configure what is sent to the proxy; and the proxy can similarly be configured where to send the logs. It defaults to forwarding everything to Datadog
At the moment, this docker container will run locally, but ultimately it will be a remote service. Therefore, opencode needs to support configuration of the location of the service
The service is optional: without it, opencode should still work, but will indicate that it cannot connect to its proxy
The proxy service will also perform other functions, such as supplying updates and prompts and flows to opencode. This logging is merely the first use of it
