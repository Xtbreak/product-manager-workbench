import React, { useLayoutEffect, useRef } from 'react';
import { Button, Message } from '@arco-design/web-react';
import { Copy, FileText, Image, Mic, Play, Smile, SquareDashed } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { DmKind, DmMessage } from '@/common/types/platform/workbenchDm';
import { groupWindow, joins, localTime } from './presentation';
import styles from './DirectMessages.module.css';

const icons = { image: Image, video: Play, voice: Mic, note_card: FileText, emoji: Smile, unknown: SquareDashed };
export function MessageStream({ messages, contactKey }: { messages: DmMessage[]; contactKey: string }) {
  const { t, i18n } = useTranslation();
  const scroller = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  useLayoutEffect(() => {
    atEnd.current = true;
  }, [contactKey]);
  useLayoutEffect(() => {
    if (scroller.current && atEnd.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [contactKey, messages.at(-1)?.id]);
  const kindLabel = (kind: Exclude<DmKind, 'text'>) => t(`common.workbench.dm.${kind}`);
  return (
    <div
      className={styles.stream}
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget;
        atEnd.current = el.scrollHeight - el.clientHeight - el.scrollTop < 36;
      }}
    >
      {messages.length === 0 && <div className={styles.empty}>{t('common.workbench.dm.noHistory')}</div>}
      {messages.map((m, i) => {
        const prev = messages[i - 1],
          next = messages[i + 1];
        const showTime = !prev || m.timestamp - prev.timestamp >= groupWindow;
        const note = m.kind === 'system' || m.kind === 'recalled';
        const copyable = m.kind === 'text' && m.text.length > 0;
        const Icon = m.kind in icons ? icons[m.kind as keyof typeof icons] : SquareDashed;
        return (
          <React.Fragment key={m.id}>
            {showTime && (
              <time className={styles.timeLine} dateTime={new Date(m.timestamp).toISOString()}>
                {localTime(m.timestamp, i18n?.language, true)}
              </time>
            )}
            {note ? (
              <p className={styles.systemMessage}>
                {m.kind === 'system' && m.text ? m.text : kindLabel(m.kind as 'system' | 'recalled')}
              </p>
            ) : (
              <div
                className={styles.messageRow}
                data-side={m.sender}
                data-previous={joins(prev, m)}
                data-next={joins(m, next)}
                aria-label={t(m.sender === 'me' ? 'common.workbench.dm.me' : 'common.workbench.dm.peer')}
              >
                <div className={styles.bubble} data-media={!copyable}>
                  {m.kind === 'text' ? (
                    m.text
                  ) : (
                    <>
                      <Icon size={16} strokeWidth={1.8} />
                      {kindLabel(m.kind)}
                    </>
                  )}
                </div>
                {copyable && (
                  <Button
                    className={styles.copy}
                    type='text'
                    size='mini'
                    aria-label={t('common.workbench.dm.copy')}
                    title={t('common.workbench.dm.copy')}
                    icon={<Copy size={13} strokeWidth={1.8} />}
                    onClick={() => {
                      void navigator.clipboard.writeText(m.text).then(
                        () => Message.success(t('common.workbench.dm.copied')),
                        () => Message.error(t('common.workbench.dm.copyFailed'))
                      );
                    }}
                  />
                )}
              </div>
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}
