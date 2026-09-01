#!/usr/bin/env bash
set -euo pipefail

readonly KIND_VERSION="v0.31.0"
readonly KUBECTL_VERSION="v1.30.13"
readonly KIND_NODE_IMAGE="kindest/node:v1.30.13@sha256:8673291894dc400e0fb4f57243f5fdc6e355ceaa765505e0e73941aa1b6e0b80"
readonly CLUSTER_NAME="github-app-admission"
readonly TOOL_DIR="${PWD}/coverage/admission-tools"
readonly KUBECONFIG_PATH="${PWD}/coverage/admission-kubeconfig"
readonly KIND_CONFIG="${PWD}/test/fixtures/workflow-runner-kind.yaml"

case "$(uname -s)" in
  Darwin) platform_os="darwin" ;;
  Linux) platform_os="linux" ;;
  *) echo "Unsupported operating system: $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) platform_arch="arm64" ;;
  x86_64 | amd64) platform_arch="amd64" ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac
readonly platform_os platform_arch
readonly KIND_ASSET="kind-${platform_os}-${platform_arch}"

# Reviewed upstream release digests. Update each version and all four targets together.
case "${platform_os}-${platform_arch}" in
  linux-amd64)
    kind_sha256="eb244cbafcc157dff60cf68693c14c9a75c4e6e6fedaf9cd71c58117cb93e3fa"
    kubectl_sha256="b92bd89b27386b671841d5970b926b645c2ae44e5ca0663cff0f1c836a1530ee"
    ;;
  linux-arm64)
    kind_sha256="8e1014e87c34901cc422a1445866835d1e666f2a61301c27e722bdeab5a1f7e4"
    kubectl_sha256="afed1753b98ab30812203cb469e013082b25502c864f2889e8a0474aac497064"
    ;;
  darwin-amd64)
    kind_sha256="a8b3cf77b2ad77aec5bf710d1a2589d9117576132af812885cad41e9dede4d4e"
    kubectl_sha256="4c51288d7f32eafcbb6762a386b8818ce40b82dc3b99e4f27866317fd7cc9e43"
    ;;
  darwin-arm64)
    kind_sha256="88bf554fe9da6311c9f8c2d082613c002911a476f6b5090e9420b35d84e70c5c"
    kubectl_sha256="04962f4182b8f0a7260376a91d3fad0ff82c27a32035e9a3eb93465321970ca6"
    ;;
esac
readonly kind_sha256 kubectl_sha256

file_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

verify_sha256() {
  local file="$1"
  local expected="$2"
  local actual
  actual="$(file_sha256 "${file}")"
  if [[ "${actual}" != "${expected}" ]]; then
    echo "Checksum mismatch for ${file}" >&2
    return 1
  fi
}

prepare_executable() {
  chmod +x "$1"
  if [[ "${platform_os}" == "darwin" ]]; then
    codesign --force --sign - "$1"
  fi
}

mkdir -p "${TOOL_DIR}"
curl --fail --location --silent --show-error \
  "https://kind.sigs.k8s.io/dl/${KIND_VERSION}/${KIND_ASSET}" \
  --output "${TOOL_DIR}/kind"
verify_sha256 "${TOOL_DIR}/kind" "${kind_sha256}"
prepare_executable "${TOOL_DIR}/kind"

curl --fail --location --silent --show-error \
  "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/${platform_os}/${platform_arch}/kubectl" \
  --output "${TOOL_DIR}/kubectl"
verify_sha256 "${TOOL_DIR}/kubectl" "${kubectl_sha256}"
prepare_executable "${TOOL_DIR}/kubectl"

export PATH="${TOOL_DIR}:${PATH}"
export KUBECONFIG="${KUBECONFIG_PATH}"

cleanup() {
  kind delete cluster --name "${CLUSTER_NAME}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

kind create cluster \
  --name "${CLUSTER_NAME}" \
  --image "${KIND_NODE_IMAGE}" \
  --config "${KIND_CONFIG}" \
  --kubeconfig "${KUBECONFIG_PATH}" \
  --wait 120s
docker exec "${CLUSTER_NAME}-control-plane" \
  grep --fixed-strings --line-regexp 'podPidsLimit: 256' /var/lib/kubelet/config.yaml
bun run scripts/test-workflow-runner-admission.ts
