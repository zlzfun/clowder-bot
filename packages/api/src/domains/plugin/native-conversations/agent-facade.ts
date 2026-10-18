import type { AgentService } from '../../cats/services/types.js';

/** The MVP exposes only the existing guarded message invocation path.
 * Native provider controls need their own binding/admission contract before exposure.
 */
export function nativeConversationAgentFacade(service: AgentService): AgentService {
  return {
    invoke: service.invoke.bind(service),
    ...(service.injectsL0Natively ? { injectsL0Natively: service.injectsL0Natively.bind(service) } : {}),
    ...(service.usesChainKeyResume ? { usesChainKeyResume: service.usesChainKeyResume.bind(service) } : {}),
    ...(service.invokeWithContinuityPreflight
      ? { invokeWithContinuityPreflight: service.invokeWithContinuityPreflight.bind(service) }
      : {}),
    ...(service.supportsToolExecutionPolicy
      ? { supportsToolExecutionPolicy: service.supportsToolExecutionPolicy.bind(service) }
      : {}),
    ...(service.freshnessCarrierCapability
      ? { freshnessCarrierCapability: service.freshnessCarrierCapability.bind(service) }
      : {}),
    ...(service.contextCapability ? { contextCapability: service.contextCapability.bind(service) } : {}),
    ...(service.contextBinding ? { contextBinding: service.contextBinding.bind(service) } : {}),
    ...(service.contextBindingForCapacity
      ? { contextBindingForCapacity: service.contextBindingForCapacity.bind(service) }
      : {}),
  };
}
