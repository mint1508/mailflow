import js from '@eslint/js';
import globals from 'globals';
import hooks from 'eslint-plugin-react-hooks';
import nextPlugin from '@next/eslint-plugin-next';
import a11y from 'eslint-plugin-jsx-a11y';
export default [{ignores:['.next/**','out/**']},{files:['{app,src}/**/*.{js,jsx}'],languageOptions:{ecmaVersion:'latest',sourceType:'module',globals:{...globals.browser,...globals.node},parserOptions:{ecmaFeatures:{jsx:true}}},plugins:{'react-hooks':hooks,'@next/next':nextPlugin,'jsx-a11y':a11y},rules:{...js.configs.recommended.rules,...hooks.configs.recommended.rules,...nextPlugin.configs.recommended.rules,...nextPlugin.configs['core-web-vitals'].rules,...a11y.configs.recommended.rules,'no-unused-vars':'off','react-hooks/exhaustive-deps':'off'}}];
