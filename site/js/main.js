(function () {
  'use strict';

  // --- Sticky Nav ---
  const nav = document.getElementById('nav');
  function updateNav() {
    nav.classList.toggle('nav--scrolled', window.scrollY > 60);
  }
  window.addEventListener('scroll', updateNav, { passive: true });
  updateNav();

  // --- Mobile Nav ---
  const navToggle = document.getElementById('navToggle');
  const navLinks = document.getElementById('navLinks');

  navToggle.addEventListener('click', function () {
    navToggle.classList.toggle('nav-toggle--open');
    navLinks.classList.toggle('nav-links--open');
  });

  navLinks.querySelectorAll('a').forEach(function (link) {
    link.addEventListener('click', function () {
      navToggle.classList.remove('nav-toggle--open');
      navLinks.classList.remove('nav-links--open');
    });
  });

  // --- Smooth scroll ---
  document.querySelectorAll('a[href^="#"]').forEach(function (anchor) {
    anchor.addEventListener('click', function (e) {
      var target = document.querySelector(this.getAttribute('href'));
      if (!target) return;
      e.preventDefault();
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  // --- Hero Particles ---
  var particleContainer = document.getElementById('heroParticles');
  if (particleContainer) {
    var colors = ['#ff00ff', '#00d4ff', '#f5a623', '#2d5bff', '#6a0dad'];
    var particleCount = 30;
    for (var i = 0; i < particleCount; i++) {
      var p = document.createElement('div');
      p.className = 'hero-particle';
      var size = 1.5 + Math.random() * 2.5;
      p.style.width = size + 'px';
      p.style.height = size + 'px';
      p.style.left = Math.random() * 100 + '%';
      p.style.background = colors[Math.floor(Math.random() * colors.length)];
      p.style.animationDuration = (12 + Math.random() * 18) + 's';
      p.style.animationDelay = (Math.random() * 15) + 's';
      particleContainer.appendChild(p);
    }
  }

  // --- Counter Animation ---
  var counters = document.querySelectorAll('.hero-stat-num');
  var countersAnimated = false;

  function animateCounters() {
    if (countersAnimated) return;
    var trigger = document.querySelector('.hero-visual');
    if (!trigger) return;
    var rect = trigger.getBoundingClientRect();
    if (rect.top < window.innerHeight && rect.bottom > 0) {
      countersAnimated = true;
      counters.forEach(function (el) {
        var target = parseInt(el.getAttribute('data-count'), 10);
        var current = 0;
        var step = Math.ceil(target / 40);
        var interval = setInterval(function () {
          current += step;
          if (current >= target) {
            current = target;
            clearInterval(interval);
          }
          el.textContent = current + '+';
        }, 40);
      });
    }
  }

  window.addEventListener('scroll', animateCounters, { passive: true });
  animateCounters();

  // --- Scroll Reveal ---
  var revealElements = document.querySelectorAll(
    '.product-card, .gadget-card, .service-card, .portfolio-card, .contact-card, .contact-form-wrapper, .section-header'
  );

  function checkReveal() {
    revealElements.forEach(function (el) {
      if (el.classList.contains('reveal--visible')) return;
      var rect = el.getBoundingClientRect();
      if (rect.top < window.innerHeight - 60) {
        el.classList.add('reveal--visible');
      }
    });
  }

  revealElements.forEach(function (el) { el.classList.add('reveal'); });
  window.addEventListener('scroll', checkReveal, { passive: true });
  checkReveal();

  // --- Contact Form ---
  var form = document.getElementById('contactForm');
  if (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var isValid = true;

      form.querySelectorAll('.form-error').forEach(function (el) { el.textContent = ''; });
      var submitBtn = form.querySelector('.form-submit');
      var successMsg = form.querySelector('.form-success');

      // Validate fields
      var name = form.querySelector('#formName');
      var email = form.querySelector('#formEmail');
      var subject = form.querySelector('#formSubject');
      var message = form.querySelector('#formMessage');

      if (!name.value.trim()) {
        name.parentNode.querySelector('.form-error').textContent = 'Please enter your name';
        isValid = false;
      }

      if (!email.value.trim() || !/\S+@\S+\.\S+/.test(email.value)) {
        email.parentNode.querySelector('.form-error').textContent = 'Please enter a valid email';
        isValid = false;
      }

      if (!subject.value) {
        subject.parentNode.querySelector('.form-error').textContent = 'Please select a subject';
        isValid = false;
      }

      if (!message.value.trim()) {
        message.parentNode.querySelector('.form-error').textContent = 'Please enter your message';
        isValid = false;
      }

      if (!isValid) return;

      // Show loading
      submitBtn.classList.add('form-submit--loading');
      submitBtn.disabled = true;

      // Simulate send (no backend yet)
      setTimeout(function () {
        submitBtn.classList.remove('form-submit--loading');
        submitBtn.disabled = false;
        form.reset();
        successMsg.classList.remove('hidden');
        setTimeout(function () { successMsg.classList.add('hidden'); }, 6000);
      }, 1500);
    });
  }

})();