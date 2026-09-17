import type { ReactNode } from 'react';
import { Button, Heading } from '@primer/react';
import { ArrowLeftIcon } from '@primer/octicons-react';
import { CopyPromptSection } from './CopyPromptSection';
import { GitignoreSection } from './GitignoreSection';
import './settings.css';

/**
 * One block of the settings page: a title, a line about what it does and the
 * controls. Every section loads and saves its own slice of /api/settings, so
 * adding a setting is adding a section and nothing else.
 */
export function SettingsSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="rv-settings__section">
      <Heading as="h2" className="rv-settings__title">
        {title}
      </Heading>
      <p className="rv-hint rv-settings__description">{description}</p>
      {children}
    </section>
  );
}

/**
 * The settings page, `#/settings`. A container for several sections — today
 * the copy prompt and where `.local-review/` gets ignored; the next setting
 * goes right below them, as another <SettingsSection>.
 *
 * `back` is the hash the page was opened from (lib/hash.ts), so «Назад»
 * returns to that screen even after a reload or when the address was opened
 * directly.
 */
export function SettingsScreen({ back }: { back: string }) {
  return (
    <div className="rv-settings">
      <div className="rv-settings__head">
        <Button
          leadingVisual={ArrowLeftIcon}
          onClick={() => {
            window.location.hash = back;
          }}
        >
          Назад
        </Button>
        <Heading as="h1" className="rv-settings__heading">
          Настройки
        </Heading>
      </div>

      <CopyPromptSection />
      <GitignoreSection />
      {/* Следующая настройка — ещё один <SettingsSection> здесь. */}
    </div>
  );
}
