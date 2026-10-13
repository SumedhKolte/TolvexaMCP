{{- define "gateway.selectorLabels" -}}
app.kubernetes.io/name: gateway
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "gateway.labels" -}}
{{ include "gateway.selectorLabels" . }}
app.kubernetes.io/part-of: team-mcp
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "gateway.image" -}}
{{- printf "%s/%s:%s" .Values.global.image.registry .Values.image.name (.Values.image.tag | default .Values.global.image.tag) -}}
{{- end -}}
