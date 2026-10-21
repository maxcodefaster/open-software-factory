{{- define "factory.name" -}}
{{- .Release.Name | trunc 40 | trimSuffix "-" -}}
{{- end -}}

{{- define "factory.labels" -}}
app.kubernetes.io/name: factory
app.kubernetes.io/instance: {{ .Release.Name | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service | quote }}
{{- end -}}

{{- define "factory.publicURL" -}}
{{- $value := required "Set publicURL to the browser-facing Factory origin" .Values.publicURL -}}
{{- $url := urlParse $value -}}
{{- if or (not (has $url.scheme (list "http" "https"))) (not $url.host) $url.userinfo $url.query $url.fragment (and $url.path (ne $url.path "/")) -}}
{{- fail "publicURL must be an HTTP(S) origin without credentials, query or path" -}}
{{- end -}}
{{- if and (not .Values.development) (ne $url.scheme "https") -}}
{{- fail "Non-development Factory requires an HTTPS publicURL" -}}
{{- end -}}
{{- if and (not .Values.development) (or (regexMatch "^[0-9.]+(:[0-9]+)?$" $url.host) (hasPrefix "[" $url.host)) -}}
{{- fail "Use a DNS hostname for publicURL so isolated runtime wildcard hosts can be routed" -}}
{{- end -}}
{{- if and .Values.development (not (regexMatch "^(localhost|127\\.0\\.0\\.1|\\[::1\\])(:[0-9]+)?$" $url.host)) -}}
{{- fail "development is limited to a loopback publicURL" -}}
{{- end -}}
{{- trimSuffix "/" $value -}}
{{- end -}}

{{- define "factory.forgeURL" -}}
{{- $value := required "Set forgejoPublicURL to the browser-facing Forgejo origin" .Values.forgejoPublicURL -}}
{{- $url := urlParse $value -}}
{{- if or (not (has $url.scheme (list "http" "https"))) (not $url.host) $url.userinfo $url.query $url.fragment (and $url.path (ne $url.path "/")) -}}
{{- fail "forgejoPublicURL must be an HTTP(S) origin without credentials, query or path" -}}
{{- end -}}
{{- if and (not .Values.development) (ne $url.scheme "https") -}}
{{- fail "Non-development Factory requires an HTTPS forgejoPublicURL" -}}
{{- end -}}
{{- if and .Values.development (not (regexMatch "^(localhost|127\\.0\\.0\\.1|\\[::1\\])(:[0-9]+)?$" $url.host)) -}}
{{- fail "development is limited to loopback Forgejo browser access" -}}
{{- end -}}
{{- if eq (trimSuffix "/" .Values.publicURL) (trimSuffix "/" $value) -}}
{{- fail "Factory and Forgejo require distinct browser origins" -}}
{{- end -}}
{{- trimSuffix "/" $value -}}
{{- end -}}

{{- define "factory.claim" -}}
accessModes: [ReadWriteOnce]
{{- with .root.Values.storageClass }}
storageClassName: {{ . | quote }}
{{- end }}
resources:
  requests:
    storage: {{ .size | quote }}
{{- end -}}

{{- define "factory.zeroBrowserURL" -}}
{{- $factory := include "factory.publicURL" . -}}
{{- if .Values.development -}}
{{- $value := required "Set developmentZeroURL to the separate loopback planning-cache listener" .Values.developmentZeroURL -}}
{{- $url := urlParse $value -}}
{{- $public := urlParse $factory -}}
{{- if or (ne $url.scheme $public.scheme) $url.userinfo $url.query $url.fragment (and $url.path (ne $url.path "/")) (ne (regexReplaceAll ":[0-9]+$" $url.host "") (regexReplaceAll ":[0-9]+$" $public.host "")) -}}
{{- fail "developmentZeroURL must use the same loopback hostname and scheme as publicURL, without a path or credentials, so session cookies are forwarded" -}}
{{- end -}}
{{- if or (eq $url.host $public.host) (eq (trimSuffix "/" $value) (trimSuffix "/" .Values.forgejoPublicURL)) -}}
{{- fail "developmentZeroURL requires its own forwarded port" -}}
{{- end -}}
{{- printf "%s/zero" (trimSuffix "/" $value) -}}
{{- else -}}
{{- if .Values.developmentZeroURL -}}
{{- fail "developmentZeroURL is only for local port-forwarding; public planning traffic uses publicURL/zero" -}}
{{- end -}}
{{- printf "%s/zero" $factory -}}
{{- end -}}
{{- end -}}
