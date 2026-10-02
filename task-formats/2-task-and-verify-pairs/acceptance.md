# Acceptance — scenarios supported by T2

Shared by every task that supports them. Each is proved by the tests tagged with its id.

## S3

Supported by: T1.3, T2.3, T4.5

```gherkin
@core
Scenario: S3 Switching a provider off removes it from consideration entirely
  Given a model whose ordering names two enabled providers
  When an administrator switches the first provider off and applies the change
  And a request for that model is then made
  Then the remaining enabled provider serves the request
  And the switched-off provider is not asked at all, even when the remaining provider fails
```

## S6

Supported by: T1.3, T2.3

```gherkin
@core
Scenario: S6 A model with no stored ordering routes by the built-in default
  Given a model with no stored provider ordering
  When a request for that model is made
  Then it is served by the built-in default preference
  And the recorded decision states that the built-in default was the source of the choice
```

## S7

Supported by: T1.3, T1.6, T2.3

```gherkin
@core
Scenario: S7 A model whose providers are all switched off refuses to serve, distinguishably
  Given a model whose ordering exists but has every provider switched off
  When a request for that model is made
  Then the request fails with a reason that names the model and says it is configured to serve nothing
  And that failure is distinguishable from the case where the model has no stored ordering at all
```

## S8

Supported by: T1.4, T2.4

```gherkin
@core
Scenario: S8 A dry run that is asked to succeed reports the provider it would have used
  Given a model with a stored provider ordering
  When a caller makes a request in dry-run mode asking for a successful outcome
  Then the response is a success
  And it names the provider that a real request would have gone to
  And the result is unambiguously marked as not being a real generation
```

## S9

Supported by: T1.4, T2.4

```gherkin
@core
Scenario: S9 A dry run that is asked to fail produces a failure without contacting anyone
  Given a model with a stored provider ordering
  When a caller makes a request in dry-run mode asking for a failing outcome
  Then the request fails in the same way a real provider failure would present
  And the provider that would have been used is still recorded
```

## S10

Supported by: T2.4, T2.5

```gherkin
@core
Scenario: S10 A dry run contacts no provider
  Given a model with a stored provider ordering
  When a caller makes a request in dry-run mode
  Then no provider is contacted
  And no external call is made on the caller's behalf
```

## S18

Supported by: T1.5, T2.2, T3.2, T4.1

```gherkin
@negative
Scenario: S18 A malformed submission is refused and the previous configuration keeps serving
  Given a stored provider ordering that is currently in force
  When an administrator submits a configuration that cannot be understood
  Then the submission is refused with a reason
  And the previously-stored ordering is still the one in force
```

## S19

Supported by: T1.5, T2.2, T3.2, T4.1

```gherkin
@negative
Scenario: S19 A submission naming an unknown provider is refused, naming every unknown one
  Given a submission that names providers the system has nothing registered for
  When it is applied
  Then it is refused
  And the refusal names every unrecognised provider, not merely the first
```

## S21

Supported by: T2.1, T2.2, T3.8

```gherkin
@negative
Scenario: S21 When the configuration store cannot be reached the last good configuration keeps serving
  Given a configuration that has been loaded and is in force
  When the configuration store becomes unreachable
  Then requests continue to be routed by the configuration already in force
  And the operational surface reports that the newest read did not succeed
```

## S22

Supported by: T2.3

```gherkin
@negative
Scenario: S22 A failing first provider hands over to the next switched-on provider
  Given a model whose ordering names three providers, the second of which is switched off
  And the first provider fails in a way that permits another to be tried
  When a request for that model is made
  Then the third provider serves it
  And the switched-off second provider was never asked
```

## S25

Supported by: T2.1, T2.2

```gherkin
@integrity
Scenario: S25 A refused configuration never disturbs the one that is serving
  Given a configuration in force
  When a replacement is offered and refused for any reason
  Then the configuration in force is byte-for-byte the one that was serving before
  And its identity is unchanged
```

## S27

Supported by: T2.6

```gherkin
@integrity
Scenario: S27 What served a request is recorded together with the request's outcome
  Given a request that results in a generation
  Then the provider that served it, the reason that provider was chosen, and the identity of the configuration in force are recorded as part of the same indivisible record as the generation itself
  And there is no state in which the generation exists without them
  And the same facts are also recorded as a routing decision in their own right, so a request that produces no artefact is still accounted for
```

## S36

Supported by: T2.1, T3.8

```gherkin
@observability
Scenario: S36 An operator can see where the live configuration came from and whether the latest read worked
  Given a running service reading its configuration from the store
  When an operator inspects the operational surface
  Then it states which source the configuration in force came from
  And whether the most recent read of that source succeeded or was refused
```

## S39

Supported by: T2.2

```gherkin
@concurrency
Scenario: S39 A configuration change landing mid-request does not change that request
  Given a request that has begun and has already resolved which provider to use
  When the configuration is replaced while that request is still running
  Then the request completes against the provider it originally resolved
  And a request begun afterwards uses the replacement
```

## S40

Supported by: T2.2

```gherkin
@concurrency
Scenario: S40 Re-applying an identical configuration is not treated as a change
  Given a stored configuration
  When an administrator applies a configuration that is equivalent to the one already in force
  Then it is accepted
  And it is reported as unchanged rather than as a new configuration
```

## S41

Supported by: T2.1, T2.2

```gherkin
@compat
Scenario: S41 The previously-supported configuration sources continue to work
  Given a deployment configured to read its routing configuration from its existing external source
  When the service starts and polls that source
  Then it loads and serves that configuration exactly as it did before this feature existed
```

## S42

Supported by: T2.4

```gherkin
@compat
Scenario: S42 A caller who says nothing about dry runs is unaffected
  Given a caller that makes a request without mentioning dry runs
  When the request is made
  Then it behaves exactly as it did before dry runs existed, including being charged
```

## S43

Supported by: T2.6

```gherkin
@compat
Scenario: S43 A caller that records a generation without the new detail still succeeds
  Given a caller that records a generation without stating the provider, the reason, or the configuration identity
  When the generation is recorded
  Then it is recorded successfully
  And the absent details are stored as absent rather than as invented values
```

## S44

Supported by: T1.3, T2.3

```gherkin
@compat
Scenario: S44 Models nobody has configured behave exactly as before
  Given a deployment upgraded to this feature with no configuration stored at all
  When requests are made across the catalogue
  Then every model is served exactly as it was before the upgrade
```

## S51

Supported by: T2.2, T5.3

```gherkin
@delivery
Scenario: S51 The deployed service reads its configuration from the store
  Given the service deployed to its hosting environment with the configuration store selected as its source
  When it starts
  Then it loads the stored configuration
  And routes requests by it
```

## S53

Supported by: T2.4

```gherkin
@money
Scenario: S53 A dry run costs nothing
  Given a caller with a known balance
  When they make a dry-run request, whether asked to succeed or to fail
  Then their balance is unchanged
  And no charge is created
```

## S55

Supported by: T1.4, T2.5, T3.5

```gherkin
@ASSUMPTION:A3.b
Scenario: S55 A dry run is recorded in the same shape as a real request
  Given a real request and a dry-run request for the same model
  Then the record of what served each is the same shape, carrying the same fields
  And the only difference is that one is marked as a dry run
  And that sameness is what makes a dry run usable as proof of what a real request would do
```

## S56

Supported by: T1.3, T1.6, T2.3

```gherkin
@integrity
Scenario: S56 A model configured to serve nothing is part of the configuration's identity
  Given two configurations that are identical except that one has a model configured to serve nothing
  Then they are not treated as the same configuration
  And the routing layer can tell, for any model, whether it is configured to serve nothing
  And that fact reaches the routing layer by the same route as the ordering itself, not by a separate channel
```

## S57

Supported by: T1.2, T2.2, T3.2

```gherkin
@concurrency
Scenario: S57 A slow read cannot undo a change that has already been applied
  Given a periodic read of the stored configuration that began before an administrator applied a change
  When that read completes after the change has taken effect
  Then it does not replace the newer configuration with the older one
  And the administrator's change is still the one in force
```

## S58

Supported by: T1.1, T2.6

```gherkin
@integrity
Scenario: S58 A request that produces nothing still records which provider it would have used
  Given a dry-run request, which creates no artefact and no charge
  Then the provider it resolved to, the reason, and the identity of the configuration in force are recorded
  And that record is readable afterwards without reference to any artefact
  And it is marked as a dry run so it can never be mistaken for real work
```

## S59

Supported by: T1.3, T2.2

```gherkin
@negative
Scenario: S59 A stored configuration naming a provider that cannot serve the model is refused
  Given a stored configuration naming a provider that is known to the system but cannot serve the model in question
  When that configuration is read
  Then it is refused
  And the refusal names every such provider, not merely the first
  And the configuration already in force keeps serving
```
