import React from 'react';
import ReactDOM from 'react-dom/client';
import '../styles/globals.css';
import compatibilityTheme from '../../../desktop/resources/theme.css?raw';
import { ThemePreview } from './ThemePreview';

document.documentElement.dataset.colorScheme = 'light';
const themeStyle = document.createElement('style');
themeStyle.textContent = compatibilityTheme;
document.head.append(themeStyle);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><ThemePreview /></React.StrictMode>,
);
