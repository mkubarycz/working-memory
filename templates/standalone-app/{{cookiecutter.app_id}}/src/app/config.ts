export const appConfig = {
  id: '{{ cookiecutter.app_id }}',
  title: '{{ cookiecutter.app_title }}',
  description: '{{ cookiecutter.app_description }}',
  version: '0.1.0',
  contractVersion: '1.0',
  port: {{ cookiecutter.port }},
  defaultHttpEnabled: {{ cookiecutter.enable_http }},
  defaultUiEnabled: {{ cookiecutter.enable_ui }},
} as const;
