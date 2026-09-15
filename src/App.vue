<script setup>
import ChatWidget from './components/ChatWidget.vue'
import AdminView from './views/AdminView.vue'
import LoginView from './views/LoginView.vue'

const login = location.pathname.startsWith('/login')
const admin = location.pathname.startsWith('/admin')
</script>

<template>
  <LoginView v-if="login" />
  <AdminView v-else-if="admin" />
  <ChatWidget v-else />
</template>
