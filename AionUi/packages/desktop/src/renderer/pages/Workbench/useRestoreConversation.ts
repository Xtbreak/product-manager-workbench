import { configService } from '@/common/config/configService';
import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { getConversationOrNull } from '@/renderer/pages/conversation/utils/conversationCache';

/** Restore once after the router normalizes '/', without overriding later intentional navigation. */
export function useRestoreConversation() {
  const location = useLocation();
  const navigate = useNavigate();
  const attempted = useRef(false);
  useEffect(() => {
    if (attempted.current || location.pathname === '/') return;
    if (location.pathname !== '/guid' || location.state) {
      attempted.current = true;
      return;
    }
    let alive = true;
    try {
      const id = configService.get('workbench.lastConversation') ?? localStorage.getItem('workbench.lastConversation');
      if (!id) {
        attempted.current = true;
        return;
      }
      void getConversationOrNull(id)
        .then((conversation) => {
          if (!alive) return;
          attempted.current = true;
          if (conversation) void navigate(`/conversation/${id}`, { replace: true });
        })
        .catch(() => {
          if (alive) attempted.current = true;
        });
    } catch {
      attempted.current = true;
    }
    return () => {
      alive = false;
    };
  }, [location.pathname, location.state, navigate]);
}
