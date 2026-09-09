<script setup>
import ChatWidget from './components/ChatWidget.vue'
import AdminView from './views/AdminView.vue'

const admin = location.pathname.startsWith('/admin')
</script>

<template>
  <AdminView v-if="admin" />
  <ChatWidget v-else />
</template>
