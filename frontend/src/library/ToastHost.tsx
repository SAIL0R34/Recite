import { useLibraryStore } from '../stores/libraryStore'

export default function ToastHost() {
  const toasts = useLibraryStore((s) => s.toasts)
  if (!toasts.length) return null
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="card pointer-events-auto max-w-sm p-3 text-sm"
          role="status"
          style={t.kind === 'error' ? { borderColor: '#b91c1c' } : undefined}
        >
          {t.msg}
        </div>
      ))}
    </div>
  )
}
