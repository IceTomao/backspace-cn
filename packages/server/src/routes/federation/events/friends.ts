import { getDb, schema } from '../../../db/index.js';
import { getOurOrigin, normalizeOriginForCompare } from '../../../utils/federationAuth.js';
import { sanitizeUser } from '../../../utils/sanitize.js';
import { generateSnowflake } from '../../../utils/snowflake.js';
import { connectionManager } from '../../../ws/handler.js';
import { and, eq, or } from 'drizzle-orm';
import type { FederationRelayEvent } from '@backspace/shared';
import { extractDomain, resolveLocalUser, resolveOrCreateReplicatedUser, verifyAttribution } from '../identity.js';
import { hydrateReplicatedUserProfile } from '../profile.js';

export async function processFriendRequestCreateEvent(
  event: FederationRelayEvent,
  sourceInstance: string,
  db: ReturnType<typeof getDb>,
  accepted: string[],
  rejected: Array<{ messageId: string; reason: string }>,
): Promise<void> {
  if (!event.friendship) {
    rejected.push({ messageId: event.messageId, reason: 'missing_friendship_payload' });
    return;
  }

  const { from, to } = event.friendship;

  // Attribution: sender must belong to source instance (FED-010)
  if (!verifyAttribution(from, sourceInstance, db)) {
    console.warn(`[federation] Attribution mismatch in friend_request_create: from homeInstance=${extractDomain(from.homeInstance)} source=${extractDomain(sourceInstance)}`);
    rejected.push({ messageId: event.messageId, reason: 'attribution_mismatch' });
    return;
  }

  // Self-target guard (defense-in-depth): from-identity must not equal to-identity.
  // Sender's local cannot_friend_self check should catch this, but the receiver must not trust it.
  if (
    from.homeUserId === to.homeUserId &&
    normalizeOriginForCompare(from.homeInstance) === normalizeOriginForCompare(to.homeInstance)
  ) {
    console.warn(`[federation] Self-target friend_request_create rejected: homeUserId=${from.homeUserId} homeInstance=${extractDomain(from.homeInstance)} source=${extractDomain(sourceInstance)}`);
    rejected.push({ messageId: event.messageId, reason: 'self_target_invalid' });
    return;
  }

  // Resolve the sender (create stub if needed — they're on a remote instance)
  const fromUserResolved = resolveOrCreateReplicatedUser(from.homeUserId, from.homeInstance, db, { username: event.friendship.fromProfile?.username, status: event.friendship.fromProfile?.status, deleted: event.friendship.fromProfile?.deleted });
  if (!fromUserResolved) {
    // Sender's identity has been deleted — silently accept to drop the event
    accepted.push(event.messageId);
    return;
  }
  let fromUser = await hydrateReplicatedUserProfile(fromUserResolved, event.friendship.fromProfile, db);

  // Resolve the recipient — must be a local user on this instance
  const toUser = resolveLocalUser(to.homeUserId, db, to.homeInstance);
  if (!toUser) {
    rejected.push({ messageId: event.messageId, reason: 'recipient_not_found' });
    return;
  }

  // Idempotency: if already friends, accept as no-op
  const existingFriend = db
    .select()
    .from(schema.friends)
    .where(
      or(
        and(eq(schema.friends.userId, fromUser.id), eq(schema.friends.friendId, toUser.id)),
        and(eq(schema.friends.userId, toUser.id), eq(schema.friends.friendId, fromUser.id)),
      ),
    )
    .get();

  if (existingFriend) {
    accepted.push(event.messageId);
    return;
  }

  // Idempotency: a pending request in EITHER direction makes this event a no-op.
  //   Forward (from→to): re-delivery of an event we've already processed.
  //   Reverse (to→from): the local user has already sent a request TO this remote sender.
  //     Race window: both sides click "add friend" near-simultaneously. Each sender's both-direction
  //     check passes locally (no rows yet anywhere). When the events cross, each receiver must
  //     treat the reverse-direction collision as idempotent — otherwise both instances end up
  //     with two opposite-direction pending rows for the same logical pair. Mirror the
  //     sender-side both-direction check (`incoming_request_exists` in social.ts).
  const existingRequest = db
    .select()
    .from(schema.friendRequests)
    .where(
      and(
        or(
          and(eq(schema.friendRequests.fromId, fromUser.id), eq(schema.friendRequests.toId, toUser.id)),
          and(eq(schema.friendRequests.fromId, toUser.id), eq(schema.friendRequests.toId, fromUser.id)),
        ),
        eq(schema.friendRequests.status, 'pending'),
      ),
    )
    .get();

  if (existingRequest) {
    accepted.push(event.messageId);
    return;
  }

  // Create the friend request
  const id = generateSnowflake();
  const now = event.friendship.createdAt || Date.now();

  db.insert(schema.friendRequests)
    .values({
      id,
      fromId: fromUser.id,
      toId: toUser.id,
      status: 'pending',
      createdAt: now,
    })
    .run();

  // Broadcast to the recipient
  connectionManager.sendToUser(toUser.id, {
    type: 'friend_request_received',
    request: {
      id,
      fromId: fromUser.id,
      toId: toUser.id,
      status: 'pending' as const,
      createdAt: now,
      user: sanitizeUser(fromUser),
    },
  });

  accepted.push(event.messageId);
}


export function processFriendRequestUpdateEvent(
  event: FederationRelayEvent,
  sourceInstance: string,
  db: ReturnType<typeof getDb>,
  accepted: string[],
  rejected: Array<{ messageId: string; reason: string }>,
): void {
  if (!event.friendship || !event.friendship.status) {
    rejected.push({ messageId: event.messageId, reason: 'missing_friendship_payload' });
    return;
  }

  const { from, to, status } = event.friendship;

  // Attribution: recipient (acceptor/decliner) must belong to source instance (FED-010)
  if (!verifyAttribution(to, sourceInstance, db)) {
    console.warn(`[federation] Attribution mismatch in friend_request_update: to homeInstance=${extractDomain(to.homeInstance)} source=${extractDomain(sourceInstance)}`);
    rejected.push({ messageId: event.messageId, reason: 'attribution_mismatch' });
    return;
  }

  // Resolve the sender — must be a local user (the one who sent the original request)
  const fromUser = resolveLocalUser(from.homeUserId, db, from.homeInstance);
  if (!fromUser) {
    rejected.push({ messageId: event.messageId, reason: 'sender_not_found' });
    return;
  }

  // The actor must already be known here: accepting a request must not create a
  // new identity row or bind a colliding homeUserId to the wrong account.
  const toUser = resolveLocalUser(to.homeUserId, db, to.homeInstance);
  if (!toUser) {
    rejected.push({ messageId: event.messageId, reason: 'recipient_not_found' });
    return;
  }

  // Find the pending request
  const pendingRequest = db
    .select()
    .from(schema.friendRequests)
    .where(
      and(
        eq(schema.friendRequests.fromId, fromUser.id),
        eq(schema.friendRequests.toId, toUser.id),
        eq(schema.friendRequests.status, 'pending'),
      ),
    )
    .get();

  if (!pendingRequest) {
    // Accept idempotently — friend_add may have arrived first
    accepted.push(event.messageId);
    return;
  }

  const now = event.friendship.createdAt || Date.now();
  db.transaction((tx) => {
    tx.update(schema.friendRequests)
      .set({ status: status as string })
      .where(eq(schema.friendRequests.id, pendingRequest.id))
      .run();
    if (status === 'accepted') {
      const existingFriend = tx.select({ userId: schema.friends.userId })
        .from(schema.friends)
        .where(or(
          and(eq(schema.friends.userId, fromUser.id), eq(schema.friends.friendId, toUser.id)),
          and(eq(schema.friends.userId, toUser.id), eq(schema.friends.friendId, fromUser.id)),
        )).get();
      if (!existingFriend) {
        tx.insert(schema.friends).values({ userId: fromUser.id, friendId: toUser.id, createdAt: now }).run();
      }
    }
  });

  if (status === 'accepted') {
    connectionManager.sendToUser(fromUser.id, {
      type: 'friend_request_accepted',
      friend: {
        ...sanitizeUser(toUser),
        addedAt: now,
      },
      requestId: pendingRequest.id,
    });
  } else if (status === 'declined') {
    connectionManager.sendToUser(fromUser.id, {
      type: 'friend_request_declined',
      requestId: pendingRequest.id,
      userId: toUser.id,
    });
  }

  accepted.push(event.messageId);
}


export function processFriendRequestCancelEvent(
  event: FederationRelayEvent,
  sourceInstance: string,
  db: ReturnType<typeof getDb>,
  accepted: string[],
  rejected: Array<{ messageId: string; reason: string }>,
): void {
  if (!event.friendship) {
    rejected.push({ messageId: event.messageId, reason: 'missing_friendship_payload' });
    return;
  }

  const { from, to } = event.friendship;

  // Attribution: sender must belong to source instance (FED-010)
  if (!verifyAttribution(from, sourceInstance, db)) {
    console.warn(`[federation] Attribution mismatch in friend_request_cancel: from homeInstance=${extractDomain(from.homeInstance)} source=${extractDomain(sourceInstance)}`);
    rejected.push({ messageId: event.messageId, reason: 'attribution_mismatch' });
    return;
  }

  // Resolve both users — must both exist locally for there to be a pending request
  const fromUser = resolveLocalUser(from.homeUserId, db, from.homeInstance);
  const toUser = resolveLocalUser(to.homeUserId, db, to.homeInstance);

  if (!fromUser || !toUser) {
    // Accept idempotently — if either user doesn't exist, there's nothing to cancel
    accepted.push(event.messageId);
    return;
  }

  // Find the pending request
  const pendingRequest = db
    .select()
    .from(schema.friendRequests)
    .where(
      and(
        eq(schema.friendRequests.fromId, fromUser.id),
        eq(schema.friendRequests.toId, toUser.id),
        eq(schema.friendRequests.status, 'pending'),
      ),
    )
    .get();

  if (!pendingRequest) {
    // Accept idempotently — already cancelled or never existed
    accepted.push(event.messageId);
    return;
  }

  // Delete the request
  db.delete(schema.friendRequests)
    .where(eq(schema.friendRequests.id, pendingRequest.id))
    .run();

  // Broadcast to the recipient
  connectionManager.sendToUser(toUser.id, {
    type: 'friend_request_cancelled',
    requestId: pendingRequest.id,
    userId: fromUser.id,
  });

  accepted.push(event.messageId);
}


export async function processFriendAddEvent(
  event: FederationRelayEvent,
  sourceInstance: string,
  db: ReturnType<typeof getDb>,
  accepted: string[],
  rejected: Array<{ messageId: string; reason: string }>,
): Promise<void> {
  if (!event.friendship) {
    rejected.push({ messageId: event.messageId, reason: 'missing_friendship_payload' });
    return;
  }

  const { from, to } = event.friendship;

  // Attribution: acceptor must belong to source instance (FED-010)
  if (!verifyAttribution(to, sourceInstance, db)) {
    console.warn(`[federation] Attribution mismatch in friend_add: to homeInstance=${extractDomain(to.homeInstance)} source=${extractDomain(sourceInstance)}`);
    rejected.push({ messageId: event.messageId, reason: 'attribution_mismatch' });
    return;
  }

  const fromUser = resolveLocalUser(from.homeUserId, db, from.homeInstance);
  const toUser = resolveLocalUser(to.homeUserId, db, to.homeInstance);
  if (!fromUser || !toUser) {
    accepted.push(event.messageId);
    return;
  }

  // Idempotency: if friendship already exists, accept as no-op
  const existingFriend = db
    .select()
    .from(schema.friends)
    .where(
      or(
        and(eq(schema.friends.userId, fromUser.id), eq(schema.friends.friendId, toUser.id)),
        and(eq(schema.friends.userId, toUser.id), eq(schema.friends.friendId, fromUser.id)),
      ),
    )
    .get();

  if (existingFriend) {
    accepted.push(event.messageId);
    return;
  }

  const pendingRequest = db.select({ id: schema.friendRequests.id })
    .from(schema.friendRequests)
    .where(and(
      eq(schema.friendRequests.fromId, fromUser.id),
      eq(schema.friendRequests.toId, toUser.id),
      eq(schema.friendRequests.status, 'pending'),
    )).get();
  if (!pendingRequest) {
    rejected.push({ messageId: event.messageId, reason: 'invalid_target' });
    return;
  }

  const now = event.friendship.createdAt || Date.now();
  db.transaction((tx) => {
    tx.insert(schema.friends).values({ userId: fromUser.id, friendId: toUser.id, createdAt: now }).run();
    tx.update(schema.friendRequests)
      .set({ status: 'accepted' })
      .where(eq(schema.friendRequests.id, pendingRequest.id))
      .run();
  });

  // Determine which user is local and broadcast to them
  const ourOrigin = getOurOrigin();
  const fromIsLocal = normalizeOriginForCompare(from.homeInstance) === normalizeOriginForCompare(ourOrigin);
  const localUser = fromIsLocal ? fromUser : toUser;
  const remoteUser = fromIsLocal ? toUser : fromUser;

  connectionManager.sendToUser(localUser.id, {
    type: 'friend_request_accepted',
    friend: {
      ...sanitizeUser(remoteUser),
      addedAt: now,
    },
    requestId: pendingRequest.id,
  });

  accepted.push(event.messageId);
}


export function processFriendRemoveEvent(
  event: FederationRelayEvent,
  sourceInstance: string,
  db: ReturnType<typeof getDb>,
  accepted: string[],
  rejected: Array<{ messageId: string; reason: string }>,
): void {
  if (!event.friendship) {
    rejected.push({ messageId: event.messageId, reason: 'missing_friendship_payload' });
    return;
  }

  const { from, to } = event.friendship;

  // Attribution: at least one side must belong to source instance (FED-010)
  if (!verifyAttribution(from, sourceInstance, db) && !verifyAttribution(to, sourceInstance, db)) {
    console.warn(`[federation] Attribution mismatch in friend_remove: from homeInstance=${extractDomain(from.homeInstance)} to homeInstance=${extractDomain(to.homeInstance)} source=${extractDomain(sourceInstance)}`);
    rejected.push({ messageId: event.messageId, reason: 'attribution_mismatch' });
    return;
  }

  // Resolve both users — must both exist locally for there to be a friendship
  const fromUser = resolveLocalUser(from.homeUserId, db, from.homeInstance);
  const toUser = resolveLocalUser(to.homeUserId, db, to.homeInstance);

  if (!fromUser || !toUser) {
    // Accept idempotently — if either user doesn't exist locally, nothing to remove
    accepted.push(event.messageId);
    return;
  }

  // Delete friendship in both directions
  db.delete(schema.friends)
    .where(
      or(
        and(eq(schema.friends.userId, fromUser.id), eq(schema.friends.friendId, toUser.id)),
        and(eq(schema.friends.userId, toUser.id), eq(schema.friends.friendId, fromUser.id)),
      ),
    )
    .run();

  // Determine which user is local (the one whose home instance is NOT the source)
  // The removing user is on the source instance; broadcast to the other user
  const ourOrigin = getOurOrigin();
  const fromIsLocal = normalizeOriginForCompare(from.homeInstance) === normalizeOriginForCompare(ourOrigin);
  const localUser = fromIsLocal ? fromUser : toUser;
  const removingUser = fromIsLocal ? toUser : fromUser;

  connectionManager.sendToUser(localUser.id, {
    type: 'friend_removed',
    userId: removingUser.id,
  });

  accepted.push(event.messageId);
}
