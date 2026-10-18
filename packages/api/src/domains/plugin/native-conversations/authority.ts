import type { NativeConversationService } from './service.js';

let authority: NativeConversationService | undefined;
export function setNativeConversationAuthority(service: NativeConversationService): void {
  authority = service;
}
/** One admission point for every native invocation path, including retry and queued turns. */
export async function authorizeNativeConversation(
  catId: string,
  owner: string,
  threadId: string,
  ownerAuthProvenance?: string,
  workspacePath?: string,
): Promise<void> {
  if (!catId.startsWith('native-')) return;
  if (ownerAuthProvenance !== 'strict') throw new Error('Native conversations require an authenticated owner message');
  if (!authority) throw new Error('Native conversation authority unavailable');
  await authority.authorize(catId, owner, threadId, workspacePath);
}
export function nativeExecutionTemplateFor(catId: string): string | undefined {
  return authority?.executionTemplateFor(catId);
}
