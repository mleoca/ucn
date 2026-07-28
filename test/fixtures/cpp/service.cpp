#include "service.hpp"

int helper(int value) {
    return value + 1;
}

int Service::run(int value) {
    return helper(value);
}
