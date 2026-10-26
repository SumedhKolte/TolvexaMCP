{{/* The effective config of this instance: defaults overlaid with upstreams.instances.<instance>. */}}
{{- define "upstream.cfg" -}}
{{- $name := required "set --set instance=<name> (an entry of upstreams.instances)" .Values.instance -}}
{{- $inst := index .Values.upstreams.instances $name | default dict -}}
{{- if not $inst }}{{ fail (printf "upstreams.instances.%s is not defined in the values" $name) }}{{ end -}}
{{- /* Reject unknown keys: a mis-indented env var must fail loudly, not vanish. */ -}}
{{- range $k, $_ := $inst }}
{{- if not (has $k (list "replicaCount" "port" "image" "tag" "imageId" "secretName" "env" "resources" "persistence")) }}
{{- fail (printf "upstreams.instances.%s: unknown key %q (did you mean to put it under env?)" $name $k) }}
{{- end }}
{{- end -}}
{{- toYaml (mergeOverwrite (deepCopy .Values.upstreams.defaults) $inst) -}}
{{- end -}}

{{- define "upstream.selectorLabels" -}}
app.kubernetes.io/name: {{ .Release.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "upstream.labels" -}}
{{ include "upstream.selectorLabels" . }}
app.kubernetes.io/component: upstream-mcp
app.kubernetes.io/part-of: team-mcp
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}
