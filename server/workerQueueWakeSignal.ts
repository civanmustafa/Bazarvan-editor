import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';

export type WorkerQueueName =
  | 'ai_jobs'
  | 'content_writing'
  | 'client_page_crawl'
  | 'external_analysis';

export const subscribeToWorkerQueueWakeSignal = (options: {
  client: SupabaseClient;
  queueName: WorkerQueueName;
  subscriberId: string;
  onWake: () => void;
  onStatus?: (status: string) => void;
}): (() => void) => {
  try {
    const safeSubscriberId = options.subscriberId.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(-80);
    const channel: RealtimeChannel = options.client
      .channel(`worker-queue-wake:${options.queueName}:${safeSubscriberId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'worker_queue_signals',
          filter: `queue_name=eq.${options.queueName}`,
        },
        () => options.onWake(),
      )
      .subscribe(status => options.onStatus?.(status));

    return () => {
      void options.client.removeChannel(channel);
    };
  } catch {
    // Realtime is an optimization only. Adaptive polling is the durable fallback.
    options.onStatus?.('CHANNEL_ERROR');
    return (): void => undefined;
  }
};
