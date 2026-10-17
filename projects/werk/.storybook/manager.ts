import { addons } from 'storybook/manager-api';
import { create } from 'storybook/theming';
addons.setConfig({ showPanel: false, theme: create({ base: 'light', brandTitle: 'Werk documentation', brandUrl: '?path=/story/documentation-start-here--welcome', brandTarget: '_self', colorPrimary: '#135c48', colorSecondary: '#135c48' }) });
