import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './api.ts';
import { useSession } from './session.tsx';
import type { CaseRow, Owner } from './types.ts';
import { actorName, toast } from './ui.tsx';

/** Whether the case's holder is whoever is signed in here, as a person or by key. */
const isMe = (owner: Owner, me: { userId: string | null; keyId: string | null }) =>
  Boolean((me.userId && owner.userId === me.userId) || (me.keyId && owner.keyId === me.keyId));

/** "You", or who holds the case: a person by name, a key as a key. */
export function ownerName(
  owner: Owner | null | undefined,
  me: { userId: string | null; keyId: string | null },
) {
  if (!owner) return null;
  return isMe(owner, me) ? 'You' : actorName(owner);
}

/** Who is working a case, and the one button to take it or let it go. */
export function CaseOwner({ c }: { c: Pick<CaseRow, 'id' | 'assignee'> }) {
  const { me, tenantId, canAct } = useSession();
  const queries = useQueryClient();
  const mine = Boolean(c.assignee && isMe(c.assignee, me));
  const change = useMutation({
    mutationFn: () => api(`/cases/${c.id}/${mine ? 'unassign' : 'assign'}`, { method: 'POST' }),
    onSuccess: () => {
      toast(mine ? 'Case released' : 'Case is yours');
      queries.invalidateQueries({ queryKey: ['tenant', tenantId] });
      queries.invalidateQueries({ queryKey: ['trail'] });
    },
    onError: (err) => toast(err.message),
  });
  return (
    <span className="owner">
      <span className={c.assignee ? undefined : 'faint'}>
        {ownerName(c.assignee, me) ?? 'Unassigned'}
      </span>
      {canAct && (
        <button
          type="button"
          className="btn small ghost"
          disabled={change.isPending}
          onClick={(e) => {
            // Rows open the case; the button only changes who holds it.
            e.stopPropagation();
            change.mutate();
          }}
        >
          {mine ? 'Release' : c.assignee ? 'Take over' : 'Take it'}
        </button>
      )}
    </span>
  );
}
