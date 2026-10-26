import { ChatCircleDotsIcon, CircleNotchIcon } from '@phosphor-icons/react';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { useLocation } from 'wouter';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, sendJson } from '@/lib/api';
import { chatHref } from '@/lib/nav';

const MODELS = [
  ['default', 'Settings default'],
  ['opus', 'Opus'],
  ['sonnet', 'Sonnet'],
  ['haiku', 'Haiku'],
  ['fable', 'Fable'],
] as const;
const EFFORTS = ['default', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/**
 * A General chat (SPEC §14.7): a Claude session with no project, in a scratch directory AoE deletes
 * with it. Starting one is your explicit click; the first message waits until Claude is at its prompt.
 */
export function NewChatDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [, navigate] = useLocation();
  const id = useId();
  const [title, setTitle] = useState('');
  const [model, setModel] = useState('default');
  const [effort, setEffort] = useState('default');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [limited, setLimited] = useState(false);

  const close = (o: boolean) => {
    onOpenChange(o);
    if (!o) {
      setError(null);
      setLimited(false);
    }
  };

  const start = async (force: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const r = await sendJson<{ sessionId: string; name: string; held: boolean }>(
        'POST',
        '/api/general/sessions',
        {
          title: title.trim() || undefined,
          model: model === 'default' ? undefined : model,
          effort: effort === 'default' ? undefined : effort,
          message: message.trim() || undefined,
          force,
        },
      );
      toast.success(
        `${r.name} started${r.held ? '; your first message goes in once Claude is at its prompt' : ''}`,
      );
      setTitle('');
      setMessage('');
      close(false);
      navigate(chatHref(r.sessionId));
    } catch (err) {
      const limit = err instanceof ApiError && (err.body as { error?: string } | null)?.error === 'limited';
      setLimited(limit);
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New chat</DialogTitle>
          <DialogDescription>
            A Claude session with no project, in a fresh scratch folder. Deleting the chat for good deletes
            that folder and everything in it.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void start(false);
          }}
        >
          <div className="space-y-2">
            <Label htmlFor={`${id}-title`}>Title</Label>
            <Input
              id={`${id}-title`}
              name="title"
              autoComplete="off"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Optional; it gets a name either way"
              className="h-10 text-[0.9375rem]"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor={`${id}-model`}>Model</Label>
              <Select value={model} onValueChange={setModel}>
                <SelectTrigger id={`${id}-model`} className="h-10 w-full text-[0.9375rem]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MODELS.map(([v, label]) => (
                    <SelectItem key={v} value={v}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${id}-effort`}>Effort</Label>
              <Select value={effort} onValueChange={setEffort}>
                <SelectTrigger id={`${id}-effort`} className="h-10 w-full text-[0.9375rem]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EFFORTS.map((v) => (
                    <SelectItem key={v} value={v}>
                      {v === 'default' ? 'Settings default' : v}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${id}-message`}>First message</Label>
            <Textarea
              id={`${id}-message`}
              name="message"
              autoComplete="off"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={4}
              className="text-[0.9375rem]"
            />
            <p className="text-sm text-muted-foreground">Optional. Sent once Claude is at its prompt.</p>
          </div>
          {error && (
            <p role="alert" className="text-sm text-attn-error">
              {error}
            </p>
          )}
          <DialogFooter>
            {limited ? (
              <Button type="button" variant="outline" disabled={busy} onClick={() => void start(true)}>
                Start anyway
              </Button>
            ) : null}
            <Button type="submit" variant="gradient" disabled={busy}>
              {busy ? <CircleNotchIcon className="animate-spin" /> : <ChatCircleDotsIcon />}
              Start chat
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
