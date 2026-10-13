{{/*
Common labels. `component` is the app name (mariadb, wordpress, store-init).
Selectors use only name + instance so they stay stable across chart upgrades.
*/}}
{{- define "store.labels" -}}
app.kubernetes.io/name: {{ .component }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/part-of: team-mcp
app.kubernetes.io/managed-by: {{ .root.Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .root.Chart.Name .root.Chart.Version }}
{{- end -}}

{{- define "store.selectorLabels" -}}
app.kubernetes.io/name: {{ .component }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
{{- end -}}

{{/* Public base URL of the store. Must match the Ingress host, or WordPress redirects break. */}}
{{- define "store.url" -}}
{{- printf "%s://%s" (ternary "https" "http" .Values.global.tls.enabled) .Values.global.storeHost -}}
{{- end -}}

{{- define "store.mariadbHost" -}}
{{- printf "mariadb.%s.svc.cluster.local" .Release.Namespace -}}
{{- end -}}

{{/* storageClassName line, omitted when empty so the cluster default applies. */}}
{{- define "store.storageClass" -}}
{{- with .Values.global.storageClass }}
storageClassName: {{ . | quote }}
{{- end }}
{{- end -}}

{{/* Pod-level security context shared by every store pod (Pod Security "restricted"). */}}
{{- define "store.podSecurityContext" -}}
runAsNonRoot: true
runAsUser: {{ .uid }}
runAsGroup: {{ .uid }}
fsGroup: {{ .uid }}
seccompProfile:
  type: RuntimeDefault
{{- end -}}

{{- define "store.containerSecurityContext" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: ["ALL"]
{{- end -}}

{{/*
Init container that copies WordPress core from the image into the /work emptyDir.
Used by both the web pod and the store-init Job, so both run the exact same core.

Why not the image entrypoint's own copy: it archives "." and tar then tries to chmod and
utime the destination root, which is a volume owned by root. As a non-root user that
fails ("Cannot change mode ... Operation not permitted"). Archiving the top-level entries
individually never touches the volume root.

`seedContent: true` (web pod) also copies the bundled themes and plugins into the
persistent wp-content volume, but only files that don't exist yet (--skip-old-files),
so plugins installed by store-init and uploads are never overwritten.
*/}}
{{- define "store.copyCoreInitContainer" -}}
- name: copy-core
  image: "{{ .root.Values.wordpress.image.repository }}:{{ .root.Values.wordpress.image.tag }}"
  imagePullPolicy: {{ .root.Values.wordpress.image.pullPolicy }}
  command: ["sh", "-ec"]
  args:
    - |
      cd /usr/src/wordpress
      tar -cf - $(ls -A | grep -vx wp-content) | tar -C /work -xf -
      {{- if .seedContent }}
      cd /usr/src/wordpress/wp-content
      tar -cf - $(ls -A) | tar -C /work/wp-content -xf - --skip-old-files
      {{- else }}
      cp wp-config-docker.php /work/wp-config.php
      {{- end }}
  resources:
    {{- toYaml .resources | nindent 4 }}
  securityContext:
    {{- include "store.containerSecurityContext" . | nindent 4 }}
  volumeMounts:
    - { name: html, mountPath: /work }
    {{- if .seedContent }}
    - { name: content, mountPath: /work/wp-content }
    {{- end }}
{{- end -}}

{{/*
Environment for anything that loads WordPress (the web pod and the wp-cli Job). The
image's wp-config-docker.php reads these with getenv(), so no wp-config.php is stored.

Salts: one secret (WORDPRESS_SALT) expands into the 8 WordPress keys/salts via
Kubernetes $(VAR) expansion. Without fixed salts the image generates random ones per
container, which logs everyone out on every restart.
*/}}
{{- define "store.wordpressEnv" -}}
- name: WORDPRESS_DB_HOST
  value: {{ include "store.mariadbHost" . | quote }}
- name: WORDPRESS_DB_NAME
  value: {{ .Values.mariadb.database | quote }}
- name: WORDPRESS_DB_USER
  value: {{ .Values.mariadb.user | quote }}
- name: WORDPRESS_DB_PASSWORD
  valueFrom:
    secretKeyRef: { name: {{ .Values.store.secrets.wordpress }}, key: WORDPRESS_DB_PASSWORD }
- name: WORDPRESS_SALT
  valueFrom:
    secretKeyRef: { name: {{ .Values.store.secrets.wordpress }}, key: WORDPRESS_SALT }
{{- range $k := list "AUTH_KEY" "SECURE_AUTH_KEY" "LOGGED_IN_KEY" "NONCE_KEY" "AUTH_SALT" "SECURE_AUTH_SALT" "LOGGED_IN_SALT" "NONCE_SALT" }}
- name: WORDPRESS_{{ $k }}
  value: "$(WORDPRESS_SALT)-{{ $k | lower }}"
{{- end }}
{{- end -}}

{{/*
Extra wp-config.php PHP (WORDPRESS_CONFIG_EXTRA), evaluated by the image's wp-config.
`webPod` adds settings that apply only to the web server, not to wp-cli.
*/}}
{{- define "store.wpConfigExtra" -}}
define('WP_HOME', '{{ include "store.url" .root }}');
define('WP_SITEURL', '{{ include "store.url" .root }}');
define('WP_ENVIRONMENT_TYPE', '{{ .root.Values.store.environmentType }}');
define('FS_METHOD', 'direct');
define('DISALLOW_FILE_EDIT', true);
define('WP_MEMORY_LIMIT', '{{ .root.Values.wordpress.php.memoryLimit }}');
{{- if .root.Values.wordpress.systemCron.enabled }}
// The wp-cron CronJob runs scheduled events; don't also spawn them on page loads.
define('DISABLE_WP_CRON', true);
{{- end }}
{{- if .webPod }}
// Plugins and core are managed by the image and the store-init Job, never from wp-admin.
define('DISALLOW_FILE_MODS', true);
define('AUTOMATIC_UPDATER_DISABLED', true);
// Internet egress is denied by NetworkPolicy; fail outbound HTTP fast instead of hanging
// wp-admin on timeouts. The site's own host (loopback for WP-Cron) stays allowed.
define('WP_HTTP_BLOCK_EXTERNAL', true);
{{- end }}
{{- end -}}
