import { useEffect, useState } from 'react';

/** Browser install prompts are optional; iOS and some browsers never emit one. */
export function useInstallPrompt() {
  const [promptEvent, setPromptEvent] = useState(null);
  const [standalone, setStandalone] = useState(() => (
    window.matchMedia?.('(display-mode: standalone)')?.matches === true || navigator.standalone === true
  ));
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    const displayMode = window.matchMedia?.('(display-mode: standalone)');
    const onDisplayMode = () => setStandalone(displayMode?.matches === true || navigator.standalone === true);
    const onPrompt = (event) => {
      // Save the one-shot event for a button the user chooses to press later.
      event.preventDefault();
      setPromptEvent(event);
    };
    const onInstalled = () => { setPromptEvent(null); setInstalled(true); };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    if (displayMode?.addEventListener) displayMode.addEventListener('change', onDisplayMode);
    else displayMode?.addListener?.(onDisplayMode);
    onDisplayMode();
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
      if (displayMode?.removeEventListener) displayMode.removeEventListener('change', onDisplayMode);
      else displayMode?.removeListener?.(onDisplayMode);
    };
  }, []);

  async function install() {
    const event = promptEvent;
    if (!event) return;
    // An install prompt can only be shown once, even if dismissed or rejected.
    setPromptEvent(null);
    try {
      const result = await event.prompt();
      // The appinstalled event is authoritative; acceptance alone is not a
      // guarantee that installation finished or that this tab is standalone.
      return result?.outcome || (await event.userChoice)?.outcome;
    } catch {
      return undefined;
    }
  }

  return { canPrompt: Boolean(promptEvent) && !standalone, standalone, installed, install };
}
