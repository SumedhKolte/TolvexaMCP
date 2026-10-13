{{- define "wooMcp.labels" -}}
app.kubernetes.io/name: woo-mcp
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/part-of: team-mcp
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "wooMcp.selectorLabels" -}}
app.kubernetes.io/name: woo-mcp
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "wooMcp.image" -}}
{{- printf "%s/%s:%s" .Values.global.image.registry .Values.wooMcp.image.name (.Values.wooMcp.image.tag | default .Values.global.image.tag) -}}
{{- end -}}
