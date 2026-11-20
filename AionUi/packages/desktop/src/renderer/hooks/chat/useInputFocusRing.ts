import { useThemeContext } from '@/renderer/hooks/context/ThemeContext';
import { useLayoutContext } from '@/renderer/hooks/context/LayoutContext';

export const useInputFocusRing = () => {
  const { theme } = useThemeContext();
  const isWorkbench = Boolean(useLayoutContext()?.workbench);
  const isDarkTheme = theme === 'dark';

  return {
    activeBorderColor: isWorkbench ? 'var(--wb-input-focus-border)' : isDarkTheme ? '#4D4B87' : '#E1E0FF',
    inactiveBorderColor: isDarkTheme ? '#3a3a4a' : '#c9cacf',
    activeShadow: isWorkbench
      ? 'var(--wb-input-focus-shadow)'
      : isDarkTheme
        ? '0px 2px 20px rgba(77, 75, 135, 0.45)'
        : '0px 2px 20px rgba(225, 224, 255, 0.6)',
  };
};
